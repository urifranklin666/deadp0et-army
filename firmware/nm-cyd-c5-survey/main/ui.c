/*
 * Three tabs: the network list, channel occupancy for each band, and an RSSI
 * trace for one network picked from the list. A timer in the LVGL task polls
 * the survey table and redraws only when a new scan has landed.
 */
#include "ui.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "board.h"
#include "esp_log.h"
#include "survey.h"

#define HEADER_H    22
#define TABBAR_H    30
#define MAX_2G_CH   13

static lv_obj_t *s_hdr_left, *s_hdr_right;
static lv_obj_t *s_tabs;
static lv_obj_t *s_table;
static lv_obj_t *s_chart_2g, *s_chart_5g;
static lv_chart_series_t *s_on_2g, *s_load_2g, *s_on_5g, *s_load_5g;
static lv_obj_t *s_track_name, *s_track_info, *s_track_rssi, *s_track_range, *s_track_chart;
static lv_chart_series_t *s_track_ser;

static uint32_t s_shown_scan;                   /* scan_no last rendered */
static uint8_t  s_row_bssid[SURVEY_MAX_APS][6]; /* table row (minus header) -> bssid */
static uint8_t  s_tracked[6];
static bool     s_tracking;

/* Snapshot taken under the survey lock, rendered after release. */
static survey_ap_t    s_snap[SURVEY_MAX_APS];
static size_t         s_snap_n;
static survey_stats_t s_snap_stats;

/* ---- helpers ------------------------------------------------------------ */

static int cmp_rssi_desc(const void *a, const void *b)
{
    const survey_ap_t *x = a, *y = b;
    bool xh = x->last_scan == s_snap_stats.scan_no, yh = y->last_scan == s_snap_stats.scan_no;
    if (xh != yh) return xh ? -1 : 1;          /* heard this scan first */
    return (int)y->rssi - (int)x->rssi;
}

static const char *display_ssid(const survey_ap_t *ap)
{
    return ap->ssid[0] ? ap->ssid : "<hidden>";
}

static lv_obj_t *make_chart(lv_obj_t *parent, int points, lv_chart_series_t **on, lv_chart_series_t **load)
{
    lv_obj_t *c = lv_chart_create(parent);
    lv_chart_set_type(c, LV_CHART_TYPE_BAR);
    lv_chart_set_point_count(c, points);
    lv_chart_set_div_line_count(c, 3, 0);
    lv_chart_set_axis_range(c, LV_CHART_AXIS_PRIMARY_Y, 0, 6);
    lv_obj_set_style_pad_column(c, 1, 0);
    lv_obj_set_style_pad_all(c, 2, 0);
    lv_obj_set_style_radius(c, 2, 0);
    *load = lv_chart_add_series(c, lv_palette_darken(LV_PALETTE_BLUE_GREY, 2), LV_CHART_AXIS_PRIMARY_Y);
    *on = lv_chart_add_series(c, lv_palette_main(LV_PALETTE_CYAN), LV_CHART_AXIS_PRIMARY_Y);
    lv_chart_set_all_values(c, *on, 0);
    lv_chart_set_all_values(c, *load, 0);
    return c;
}

static lv_obj_t *small_label(lv_obj_t *parent, const char *txt)
{
    lv_obj_t *l = lv_label_create(parent);
    lv_label_set_text(l, txt);
    lv_obj_set_style_text_font(l, &lv_font_montserrat_12, 0);
    lv_obj_set_style_text_color(l, lv_palette_lighten(LV_PALETTE_GREY, 1), 0);
    return l;
}

/* ---- tab: networks ------------------------------------------------------ */

static void table_event(lv_event_t *e)
{
    lv_obj_t *t = lv_event_get_target(e);
    uint32_t row, col;
    lv_table_get_selected_cell(t, &row, &col);
    if (row == LV_TABLE_CELL_NONE || row == 0 || row - 1 >= SURVEY_MAX_APS) return;
    memcpy(s_tracked, s_row_bssid[row - 1], 6);
    s_tracking = true;
    s_shown_scan = 0;                           /* force a redraw of the track tab */
    lv_tabview_set_active(s_tabs, 2, LV_ANIM_OFF);
}

static void build_networks(lv_obj_t *tab)
{
    lv_obj_set_style_pad_all(tab, 0, 0);
    s_table = lv_table_create(tab);
    lv_obj_set_size(s_table, LV_PCT(100), LV_PCT(100));
    lv_table_set_column_count(s_table, 4);
    lv_table_set_column_width(s_table, 0, 154);
    lv_table_set_column_width(s_table, 1, 62);
    lv_table_set_column_width(s_table, 2, 44);
    lv_table_set_column_width(s_table, 3, 56);
    lv_obj_set_style_pad_top(s_table, 3, LV_PART_ITEMS);
    lv_obj_set_style_pad_bottom(s_table, 3, LV_PART_ITEMS);
    lv_obj_set_style_pad_left(s_table, 4, LV_PART_ITEMS);
    lv_obj_set_style_pad_right(s_table, 2, LV_PART_ITEMS);
    lv_obj_set_style_text_font(s_table, &lv_font_montserrat_12, LV_PART_ITEMS);
    lv_table_set_row_count(s_table, 2);
    lv_table_set_cell_value(s_table, 0, 0, "SSID");
    lv_table_set_cell_value(s_table, 0, 1, "Band/Ch");
    lv_table_set_cell_value(s_table, 0, 2, "dBm");
    lv_table_set_cell_value(s_table, 0, 3, "Sec");
    lv_table_set_cell_value(s_table, 1, 0, "scanning...");
    lv_obj_add_event_cb(s_table, table_event, LV_EVENT_VALUE_CHANGED, NULL);
}

static void render_networks(void)
{
    qsort(s_snap, s_snap_n, sizeof(s_snap[0]), cmp_rssi_desc);
    lv_table_set_row_count(s_table, s_snap_n + 1);
    for (size_t i = 0; i < s_snap_n; i++) {
        const survey_ap_t *ap = &s_snap[i];
        char buf[24];
        memcpy(s_row_bssid[i], ap->bssid, 6);
        lv_table_set_cell_value(s_table, i + 1, 0, display_ssid(ap));
        snprintf(buf, sizeof buf, "%s %u", ap->band5 ? "5G" : "2G", ap->channel);
        lv_table_set_cell_value(s_table, i + 1, 1, buf);
        if (ap->last_scan == s_snap_stats.scan_no) snprintf(buf, sizeof buf, "%d", ap->rssi);
        else snprintf(buf, sizeof buf, "--");
        lv_table_set_cell_value(s_table, i + 1, 2, buf);
        lv_table_set_cell_value(s_table, i + 1, 3, survey_auth_name(ap->auth));
    }
    if (s_snap_n == 0) {
        lv_table_set_row_count(s_table, 2);
        lv_table_set_cell_value(s_table, 1, 0, "nothing heard yet");
        lv_table_set_cell_value(s_table, 1, 1, "");
        lv_table_set_cell_value(s_table, 1, 2, "");
        lv_table_set_cell_value(s_table, 1, 3, "");
    }
}

/* ---- tab: channels ------------------------------------------------------ */

static void place_tick_labels(lv_obj_t *parent, lv_obj_t *chart, int points, const int *idx, const char **txt, int n)
{
    /* Chart width is known after layout; use the configured width instead. */
    int w = lv_obj_get_style_width(chart, 0);
    int x0 = lv_obj_get_style_x(chart, 0);
    int y = lv_obj_get_style_y(chart, 0) + lv_obj_get_style_height(chart, 0) + 1;
    for (int i = 0; i < n; i++) {
        lv_obj_t *l = small_label(parent, txt[i]);
        int cx = x0 + 2 + ((2 * idx[i] + 1) * (w - 4)) / (2 * points);
        lv_obj_set_pos(l, cx - 6, y);
    }
}

static void build_channels(lv_obj_t *tab)
{
    lv_obj_set_style_pad_all(tab, 0, 0);
    lv_obj_remove_flag(tab, LV_OBJ_FLAG_SCROLLABLE);
    const int avail = BOARD_LCD_V_RES - HEADER_H - TABBAR_H;   /* 188 */
    const int chart_h = 62;

    lv_obj_t *t1 = small_label(tab, "2.4 GHz   bright: on channel   dim: overlapping");
    lv_obj_set_pos(t1, 4, 2);
    s_chart_2g = make_chart(tab, MAX_2G_CH, &s_on_2g, &s_load_2g);
    lv_obj_set_pos(s_chart_2g, 4, 17);
    lv_obj_set_size(s_chart_2g, BOARD_LCD_H_RES - 8, chart_h);
    {
        static const int idx[] = { 0, 5, 10, 12 };
        static const char *txt[] = { "1", "6", "11", "13" };
        place_tick_labels(tab, s_chart_2g, MAX_2G_CH, idx, txt, 4);
    }

    lv_obj_t *t2 = small_label(tab, "5 GHz");
    lv_obj_set_pos(t2, 4, 17 + chart_h + 16);
    s_chart_5g = make_chart(tab, SURVEY_5G_COUNT, &s_on_5g, &s_load_5g);
    lv_obj_set_pos(s_chart_5g, 4, 17 + chart_h + 31);
    lv_obj_set_size(s_chart_5g, BOARD_LCD_H_RES - 8, avail - (17 + chart_h + 31) - 16);
    {
        static const int idx[] = { 0, 7, 8, 19, 20, 27 };
        static const char *txt[] = { "36", "64", "100", "144", "149", "177" };
        place_tick_labels(tab, s_chart_5g, SURVEY_5G_COUNT, idx, txt, 6);
    }
}

static void render_channels(void)
{
    int max2 = 4, max5 = 4;
    for (int ch = 1; ch <= MAX_2G_CH; ch++) {
        if (s_snap_stats.load_2g[ch] > max2) max2 = s_snap_stats.load_2g[ch];
        lv_chart_set_value_by_id(s_chart_2g, s_on_2g, ch - 1, s_snap_stats.on_2g[ch]);
        lv_chart_set_value_by_id(s_chart_2g, s_load_2g, ch - 1, s_snap_stats.load_2g[ch]);
    }
    for (int i = 0; i < SURVEY_5G_COUNT; i++) {
        if (s_snap_stats.load_5g[i] > max5) max5 = s_snap_stats.load_5g[i];
        lv_chart_set_value_by_id(s_chart_5g, s_on_5g, i, s_snap_stats.on_5g[i]);
        lv_chart_set_value_by_id(s_chart_5g, s_load_5g, i, s_snap_stats.load_5g[i]);
    }
    lv_chart_set_axis_range(s_chart_2g, LV_CHART_AXIS_PRIMARY_Y, 0, max2);
    lv_chart_set_axis_range(s_chart_5g, LV_CHART_AXIS_PRIMARY_Y, 0, max5);
    lv_chart_refresh(s_chart_2g);
    lv_chart_refresh(s_chart_5g);
}

/* ---- tab: track --------------------------------------------------------- */

static void build_track(lv_obj_t *tab)
{
    lv_obj_set_style_pad_all(tab, 0, 0);
    lv_obj_remove_flag(tab, LV_OBJ_FLAG_SCROLLABLE);

    s_track_name = lv_label_create(tab);
    lv_obj_set_style_text_font(s_track_name, &lv_font_montserrat_14, 0);
    lv_label_set_long_mode(s_track_name, LV_LABEL_LONG_DOT);
    lv_obj_set_width(s_track_name, 210);
    lv_obj_set_pos(s_track_name, 6, 4);
    lv_label_set_text(s_track_name, "Tap a network in the list");

    s_track_info = small_label(tab, "");
    lv_obj_set_pos(s_track_info, 6, 24);

    s_track_rssi = lv_label_create(tab);
    lv_obj_set_style_text_font(s_track_rssi, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(s_track_rssi, lv_palette_main(LV_PALETTE_CYAN), 0);
    lv_obj_set_width(s_track_rssi, 96);
    lv_obj_set_style_text_align(s_track_rssi, LV_TEXT_ALIGN_RIGHT, 0);
    lv_obj_set_pos(s_track_rssi, BOARD_LCD_H_RES - 102, 2);
    lv_label_set_text(s_track_rssi, "");

    s_track_range = small_label(tab, "");
    lv_obj_set_width(s_track_range, 150);
    lv_obj_set_style_text_align(s_track_range, LV_TEXT_ALIGN_RIGHT, 0);
    lv_obj_set_pos(s_track_range, BOARD_LCD_H_RES - 156, 26);

    s_track_chart = lv_chart_create(tab);
    lv_chart_set_type(s_track_chart, LV_CHART_TYPE_LINE);
    lv_chart_set_point_count(s_track_chart, SURVEY_HIST);
    lv_chart_set_axis_range(s_track_chart, LV_CHART_AXIS_PRIMARY_Y, -100, -20);
    lv_chart_set_div_line_count(s_track_chart, 5, 0);
    lv_obj_set_style_size(s_track_chart, 0, 0, LV_PART_INDICATOR);   /* no point markers */
    lv_obj_set_style_line_width(s_track_chart, 2, LV_PART_ITEMS);
    lv_obj_set_style_pad_all(s_track_chart, 2, 0);
    lv_obj_set_pos(s_track_chart, 4, 44);
    lv_obj_set_size(s_track_chart, BOARD_LCD_H_RES - 8, BOARD_LCD_V_RES - HEADER_H - TABBAR_H - 48);
    s_track_ser = lv_chart_add_series(s_track_chart, lv_palette_main(LV_PALETTE_CYAN), LV_CHART_AXIS_PRIMARY_Y);
    lv_chart_set_all_values(s_track_chart, s_track_ser, LV_CHART_POINT_NONE);

    lv_obj_t *lo = small_label(tab, "-100");
    lv_obj_set_pos(lo, 8, BOARD_LCD_V_RES - HEADER_H - TABBAR_H - 18);
    lv_obj_t *hi = small_label(tab, "-20 dBm, last 60 scans");
    lv_obj_set_pos(hi, 8, 46);
}

static void render_track(void)
{
    const survey_ap_t *ap = NULL;
    for (size_t i = 0; i < s_snap_n; i++) if (!memcmp(s_snap[i].bssid, s_tracked, 6)) { ap = &s_snap[i]; break; }
    if (!s_tracking) return;
    if (!ap) {
        lv_label_set_text(s_track_info, "not heard recently; dropped from the table");
        lv_label_set_text(s_track_rssi, "--");
        return;
    }
    lv_label_set_text(s_track_name, display_ssid(ap));
    char bw[8] = "";
    if (ap->bw_mhz > 20) snprintf(bw, sizeof bw, "/%u", ap->bw_mhz);
    lv_label_set_text_fmt(s_track_info, "%02X:%02X:%02X:%02X:%02X:%02X  %s ch %u%s  %s  802.11%s",
                          ap->bssid[0], ap->bssid[1], ap->bssid[2], ap->bssid[3], ap->bssid[4], ap->bssid[5],
                          ap->band5 ? "5G" : "2.4G", ap->channel, bw,
                          survey_auth_name(ap->auth), survey_phy_name(ap->phy, ap->band5));
    if (ap->last_scan == s_snap_stats.scan_no) lv_label_set_text_fmt(s_track_rssi, "%d dBm", ap->rssi);
    else lv_label_set_text(s_track_rssi, "--");

    int mn = 0, mx = -127, sum = 0, cnt = 0;
    lv_chart_set_all_values(s_track_chart, s_track_ser, LV_CHART_POINT_NONE);
    for (int i = 0; i < ap->hist_len; i++) {
        /* oldest first */
        int pos = (ap->hist_head + SURVEY_HIST - ap->hist_len + i) % SURVEY_HIST;
        int8_t v = ap->hist[pos];
        int slot = SURVEY_HIST - ap->hist_len + i;
        if (v == SURVEY_NO_SIGNAL) continue;
        lv_chart_set_value_by_id(s_track_chart, s_track_ser, slot, v);
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        sum += v;
        cnt++;
    }
    lv_chart_refresh(s_track_chart);
    if (cnt) lv_label_set_text_fmt(s_track_range, "min %d  avg %d  max %d", mn, sum / cnt, mx);
    else lv_label_set_text(s_track_range, "");
}

/* ---- header + timer ----------------------------------------------------- */

static void refresh_timer(lv_timer_t *t)
{
    (void)t;
    if (!survey_lock(50)) return;
    const survey_stats_t *st = survey_stats();
    bool fresh = st->scan_no != s_shown_scan;
    if (fresh) {
        size_t n;
        const survey_ap_t *aps = survey_aps(&n);
        s_snap_n = n;
        memcpy(s_snap, aps, n * sizeof(*aps));
        s_snap_stats = *st;
    }
    survey_unlock();
    if (!fresh) return;
    s_shown_scan = s_snap_stats.scan_no;

    lv_label_set_text_fmt(s_hdr_left, "scan %lu  %lu.%lus", (unsigned long)s_snap_stats.scan_no,
                          (unsigned long)(s_snap_stats.scan_ms / 1000), (unsigned long)((s_snap_stats.scan_ms % 1000) / 100));
    lv_label_set_text_fmt(s_hdr_right, "%u nets  2.4G %u  5G %u%s", s_snap_stats.n_aps, s_snap_stats.n_2g, s_snap_stats.n_5g,
                          board_sd_mounted() ? "  SD" : "");
    render_networks();
    render_channels();
    render_track();
}

void ui_init(lv_display_t *disp)
{
    lv_theme_t *th = lv_theme_default_init(disp, lv_palette_main(LV_PALETTE_CYAN), lv_palette_main(LV_PALETTE_AMBER),
                                           true, &lv_font_montserrat_12);
    lv_display_set_theme(disp, th);
    lv_obj_t *scr = lv_display_get_screen_active(disp);
    lv_obj_set_style_pad_all(scr, 0, 0);

    lv_obj_t *hdr = lv_obj_create(scr);
    lv_obj_remove_style_all(hdr);
    lv_obj_set_size(hdr, BOARD_LCD_H_RES, HEADER_H);
    lv_obj_set_pos(hdr, 0, 0);
    lv_obj_set_style_bg_color(hdr, lv_palette_darken(LV_PALETTE_BLUE_GREY, 4), 0);
    lv_obj_set_style_bg_opa(hdr, LV_OPA_COVER, 0);
    s_hdr_left = small_label(hdr, "starting Wi-Fi");
    lv_obj_align(s_hdr_left, LV_ALIGN_LEFT_MID, 6, 0);
    s_hdr_right = small_label(hdr, "");
    lv_obj_align(s_hdr_right, LV_ALIGN_RIGHT_MID, -6, 0);

    s_tabs = lv_tabview_create(scr);
    lv_obj_set_size(s_tabs, BOARD_LCD_H_RES, BOARD_LCD_V_RES - HEADER_H);
    lv_obj_set_pos(s_tabs, 0, HEADER_H);
    lv_tabview_set_tab_bar_position(s_tabs, LV_DIR_BOTTOM);
    lv_tabview_set_tab_bar_size(s_tabs, TABBAR_H);
    build_networks(lv_tabview_add_tab(s_tabs, "Networks"));
    build_channels(lv_tabview_add_tab(s_tabs, "Channels"));
    build_track(lv_tabview_add_tab(s_tabs, "Track"));

    lv_timer_create(refresh_timer, 500, NULL);
}
