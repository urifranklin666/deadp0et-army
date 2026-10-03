#pragma once
#include "lvgl.h"

/* Build the screens on the display and start the refresh timer. Call from
 * inside lvgl_port_lock(). */
void ui_init(lv_display_t *disp);
