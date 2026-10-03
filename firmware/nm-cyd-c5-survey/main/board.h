#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "lvgl.h"

/* Landscape: the ST7789 is 240x320 native and is rotated in the panel driver. */
#define BOARD_LCD_H_RES 320
#define BOARD_LCD_V_RES 240

/* SPI bus, LCD, touch, backlight, WS2812 and LVGL. Fatal on LCD failure. */
esp_err_t board_init(void);

/* Mount the microSD on the shared bus at /sdcard. False when no card. */
bool board_sd_mount(void);
bool board_sd_mounted(void);

lv_display_t *board_display(void);

/* One WS2812. Values are 0..255; keep them low, the LED is bright. */
void board_led(uint8_t r, uint8_t g, uint8_t b);
