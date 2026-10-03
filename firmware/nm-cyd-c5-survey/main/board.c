/*
 * NM-CYD-C5 bring-up: one SPI bus (FSPI/SPI2) shared by the LCD, the XPT2046
 * and the microSD, each on its own chip select. esp_lcd and sdspi both take
 * the bus lock, so they interleave safely; the cost is that a burst of SD
 * writes stalls the display for a moment.
 */
#include "board.h"

#include "driver/gpio.h"
#include "driver/sdspi_host.h"
#include "driver/spi_master.h"
#include "esp_check.h"
#include "esp_lcd_ili9341.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_lcd_touch_xpt2046.h"
#include "esp_log.h"
#include "esp_lvgl_port.h"
#include "esp_vfs_fat.h"
#include "led_strip.h"
#include "sdmmc_cmd.h"

static const char *TAG = "board";

/* Kconfig leaves a bool that is off undefined; make them plain 0/1. */
#ifndef CONFIG_SURVEY_LCD_BGR
#define CONFIG_SURVEY_LCD_BGR 0
#endif
#ifndef CONFIG_SURVEY_LCD_INVERT
#define CONFIG_SURVEY_LCD_INVERT 0
#endif
#ifndef CONFIG_SURVEY_LCD_SWAP_XY
#define CONFIG_SURVEY_LCD_SWAP_XY 0
#endif
#ifndef CONFIG_SURVEY_LCD_MIRROR_X
#define CONFIG_SURVEY_LCD_MIRROR_X 0
#endif
#ifndef CONFIG_SURVEY_LCD_MIRROR_Y
#define CONFIG_SURVEY_LCD_MIRROR_Y 0
#endif
#ifndef CONFIG_SURVEY_TOUCH_SWAP_XY
#define CONFIG_SURVEY_TOUCH_SWAP_XY 0
#endif
#ifndef CONFIG_SURVEY_TOUCH_MIRROR_X
#define CONFIG_SURVEY_TOUCH_MIRROR_X 0
#endif
#ifndef CONFIG_SURVEY_TOUCH_MIRROR_Y
#define CONFIG_SURVEY_TOUCH_MIRROR_Y 0
#endif

#define LCD_HOST        SPI2_HOST
#define LCD_CMD_BITS    8
#define LCD_PARAM_BITS  8
#define DRAW_BUF_LINES  24      /* two 320x24 RGB565 buffers in internal DMA RAM */

static lv_display_t *s_disp;
static esp_lcd_touch_handle_t s_touch;
static led_strip_handle_t s_led;
static sdmmc_card_t *s_card;

/* ---- touch calibration -------------------------------------------------- */

/*
 * The XPT2046 driver is configured with x_max = y_max = 4095 so it hands us
 * raw ADC counts; this maps them to screen pixels using the edge values from
 * menuconfig. Resistive panels vary enough that a fixed 0..4095 mapping is
 * visibly off, which is why the calibration is a config and not a constant.
 */
static uint16_t map_axis(int raw, int lo, int hi, int size)
{
    if (hi == lo) return 0;
    int v = (int)(((long)(raw - lo) * (size - 1)) / (hi - lo));
    if (v < 0) v = 0;
    if (v > size - 1) v = size - 1;
    return (uint16_t)v;
}

static void touch_map(esp_lcd_touch_handle_t tp, uint16_t *x, uint16_t *y, uint16_t *strength,
                      uint8_t *point_num, uint8_t max_point_num)
{
    (void)tp; (void)strength; (void)max_point_num;
    for (int i = 0; i < *point_num; i++) {
        int rx = x[i], ry = y[i];
        int px, py;
        if (CONFIG_SURVEY_TOUCH_SWAP_XY) {
            px = map_axis(ry, CONFIG_SURVEY_TOUCH_RAW_YMIN, CONFIG_SURVEY_TOUCH_RAW_YMAX, BOARD_LCD_H_RES);
            py = map_axis(rx, CONFIG_SURVEY_TOUCH_RAW_XMIN, CONFIG_SURVEY_TOUCH_RAW_XMAX, BOARD_LCD_V_RES);
        } else {
            px = map_axis(rx, CONFIG_SURVEY_TOUCH_RAW_XMIN, CONFIG_SURVEY_TOUCH_RAW_XMAX, BOARD_LCD_H_RES);
            py = map_axis(ry, CONFIG_SURVEY_TOUCH_RAW_YMIN, CONFIG_SURVEY_TOUCH_RAW_YMAX, BOARD_LCD_V_RES);
        }
        if (CONFIG_SURVEY_TOUCH_MIRROR_X) px = BOARD_LCD_H_RES - 1 - px;
        if (CONFIG_SURVEY_TOUCH_MIRROR_Y) py = BOARD_LCD_V_RES - 1 - py;
#if CONFIG_SURVEY_TOUCH_DEBUG
        ESP_LOGI(TAG, "touch raw=(%d,%d) -> px=(%d,%d)", rx, ry, px, py);
#endif
        x[i] = px;
        y[i] = py;
    }
}

/* ---- LCD ---------------------------------------------------------------- */

static esp_err_t lcd_init(void)
{
    spi_bus_config_t bus = {
        .sclk_io_num = CONFIG_SURVEY_PIN_SCLK,
        .mosi_io_num = CONFIG_SURVEY_PIN_MOSI,
        .miso_io_num = CONFIG_SURVEY_PIN_MISO,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = BOARD_LCD_H_RES * DRAW_BUF_LINES * sizeof(uint16_t),
    };
    ESP_RETURN_ON_ERROR(spi_bus_initialize(LCD_HOST, &bus, SPI_DMA_CH_AUTO), TAG, "spi bus");

    esp_lcd_panel_io_handle_t io = NULL;
    esp_lcd_panel_io_spi_config_t io_cfg = {
        .dc_gpio_num = CONFIG_SURVEY_PIN_LCD_DC,
        .cs_gpio_num = CONFIG_SURVEY_PIN_LCD_CS,
        .pclk_hz = CONFIG_SURVEY_LCD_PCLK_MHZ * 1000 * 1000,
        .lcd_cmd_bits = LCD_CMD_BITS,
        .lcd_param_bits = LCD_PARAM_BITS,
        .spi_mode = 0,
        .trans_queue_depth = 10,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)LCD_HOST, &io_cfg, &io), TAG, "lcd io");

    esp_lcd_panel_handle_t panel = NULL;
    esp_lcd_panel_dev_config_t panel_cfg = {
        .reset_gpio_num = CONFIG_SURVEY_PIN_LCD_RST,
        .rgb_ele_order = CONFIG_SURVEY_LCD_BGR ? LCD_RGB_ELEMENT_ORDER_BGR : LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = 16,
    };
#if CONFIG_SURVEY_LCD_ILI9341
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_ili9341(io, &panel_cfg, &panel), TAG, "ili9341");
#else
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_st7789(io, &panel_cfg, &panel), TAG, "st7789");
#endif
    ESP_RETURN_ON_ERROR(esp_lcd_panel_reset(panel), TAG, "reset");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_init(panel), TAG, "init");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_invert_color(panel, CONFIG_SURVEY_LCD_INVERT), TAG, "invert");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_disp_on_off(panel, true), TAG, "on");

    const lvgl_port_display_cfg_t disp_cfg = {
        .io_handle = io,
        .panel_handle = panel,
        .buffer_size = BOARD_LCD_H_RES * DRAW_BUF_LINES,
        .double_buffer = true,
        .hres = BOARD_LCD_H_RES,
        .vres = BOARD_LCD_V_RES,
        .monochrome = false,
        .color_format = LV_COLOR_FORMAT_RGB565,
        .rotation = {
            .swap_xy = CONFIG_SURVEY_LCD_SWAP_XY,
            .mirror_x = CONFIG_SURVEY_LCD_MIRROR_X,
            .mirror_y = CONFIG_SURVEY_LCD_MIRROR_Y,
        },
        .flags = {
            .buff_dma = true,
            .swap_bytes = true,     /* SPI panels take RGB565 big-endian */
        },
    };
    s_disp = lvgl_port_add_disp(&disp_cfg);
    ESP_RETURN_ON_FALSE(s_disp, ESP_FAIL, TAG, "lvgl display");
    return ESP_OK;
}

static esp_err_t touch_init(void)
{
    esp_lcd_panel_io_handle_t io = NULL;
    esp_lcd_panel_io_spi_config_t io_cfg = ESP_LCD_TOUCH_IO_SPI_XPT2046_CONFIG(CONFIG_SURVEY_PIN_TOUCH_CS);
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)LCD_HOST, &io_cfg, &io), TAG, "touch io");

    esp_lcd_touch_config_t cfg = {
        .x_max = 4095,              /* raw counts; touch_map does the scaling */
        .y_max = 4095,
        .rst_gpio_num = GPIO_NUM_NC,
        .int_gpio_num = GPIO_NUM_NC,/* PENIRQ is not routed on this board */
        .flags = { .swap_xy = 0, .mirror_x = 0, .mirror_y = 0 },
        .process_coordinates = touch_map,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_touch_new_spi_xpt2046(io, &cfg, &s_touch), TAG, "xpt2046");

    const lvgl_port_touch_cfg_t tcfg = { .disp = s_disp, .handle = s_touch };
    ESP_RETURN_ON_FALSE(lvgl_port_add_touch(&tcfg), ESP_FAIL, TAG, "lvgl touch");
    return ESP_OK;
}

static void backlight_on(void)
{
    gpio_config_t bl = {
        .pin_bit_mask = 1ULL << CONFIG_SURVEY_PIN_BACKLIGHT,
        .mode = GPIO_MODE_OUTPUT,
    };
    gpio_config(&bl);
    gpio_set_level(CONFIG_SURVEY_PIN_BACKLIGHT, 1);
}

static void led_init(void)
{
    led_strip_config_t strip = {
        .strip_gpio_num = CONFIG_SURVEY_PIN_LED,
        .max_leds = 1,
        .led_model = LED_MODEL_WS2812,
        .color_component_format = LED_STRIP_COLOR_COMPONENT_FMT_GRB,
    };
    led_strip_rmt_config_t rmt = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 10 * 1000 * 1000,
    };
    if (led_strip_new_rmt_device(&strip, &rmt, &s_led) != ESP_OK) {
        ESP_LOGW(TAG, "WS2812 unavailable; continuing without it");
        s_led = NULL;
        return;
    }
    led_strip_clear(s_led);
}

void board_led(uint8_t r, uint8_t g, uint8_t b)
{
    if (!s_led) return;
    led_strip_set_pixel(s_led, 0, r, g, b);
    led_strip_refresh(s_led);
}

bool board_sd_mount(void)
{
    sdmmc_host_t host = SDSPI_HOST_DEFAULT();
    host.slot = LCD_HOST;
    sdspi_device_config_t slot = SDSPI_DEVICE_CONFIG_DEFAULT();
    slot.gpio_cs = CONFIG_SURVEY_PIN_SD_CS;
    slot.host_id = LCD_HOST;
    esp_vfs_fat_sdmmc_mount_config_t mount = {
        .format_if_mount_failed = false,
        .max_files = 2,
        .allocation_unit_size = 16 * 1024,
    };
    esp_err_t err = esp_vfs_fat_sdspi_mount("/sdcard", &host, &slot, &mount, &s_card);
    if (err != ESP_OK) {
        ESP_LOGI(TAG, "no microSD (%s); logging disabled", esp_err_to_name(err));
        s_card = NULL;
        return false;
    }
    ESP_LOGI(TAG, "microSD mounted: %s, %llu MB", s_card->cid.name,
             ((uint64_t)s_card->csd.capacity * s_card->csd.sector_size) >> 20);
    return true;
}

bool board_sd_mounted(void) { return s_card != NULL; }

lv_display_t *board_display(void) { return s_disp; }

esp_err_t board_init(void)
{
    const lvgl_port_cfg_t port = ESP_LVGL_PORT_INIT_CONFIG();
    ESP_RETURN_ON_ERROR(lvgl_port_init(&port), TAG, "lvgl port");
    ESP_RETURN_ON_ERROR(lcd_init(), TAG, "lcd");
    backlight_on();
    esp_err_t terr = touch_init();
    if (terr != ESP_OK) ESP_LOGW(TAG, "touch init failed (%s); display only", esp_err_to_name(terr));
    led_init();
    return ESP_OK;
}
