idf_component_register(
    SRCS "main.c" "board.c" "survey.c" "ui.c"
    INCLUDE_DIRS "."
    REQUIRES esp_wifi esp_event esp_netif nvs_flash esp_timer esp_lcd fatfs sdmmc esp_driver_sdspi esp_driver_spi esp_driver_gpio
             lvgl esp_lvgl_port esp_lcd_touch esp_lcd_touch_xpt2046 esp_lcd_ili9341 led_strip)
