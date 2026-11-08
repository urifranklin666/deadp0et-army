#include "board.h"
#include "esp_log.h"
#include "esp_lvgl_port.h"
#include "survey.h"
#include "ui.h"

void app_main(void)
{
    ESP_ERROR_CHECK(board_init());
    board_sd_mount();
    if (lvgl_port_lock(0)) {
        ui_init(board_display());
        lvgl_port_unlock();
    }
    survey_start();
}
