/*
 * Dual-band scanner. One task scans both bands back to back, merges the
 * result into a table keyed by BSSID, keeps a short RSSI history per network,
 * and tallies per-channel occupancy. Nothing here touches LVGL; the UI reads
 * the table under the lock from its own timer.
 */
#include "survey.h"

#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include "board.h"
#include "esp_check.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "nvs_flash.h"

static const char *TAG = "survey";

const uint8_t survey_5g_channels[SURVEY_5G_COUNT] = {
    36, 40, 44, 48, 52, 56, 60, 64,
    100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144,
    149, 153, 157, 161, 165, 169, 173, 177,
};

static survey_ap_t s_aps[SURVEY_MAX_APS];
static size_t s_n_aps;
static survey_stats_t s_stats;
static SemaphoreHandle_t s_lock;

/* ---- helpers ------------------------------------------------------------ */

static int idx_5g(uint8_t ch)
{
    for (int i = 0; i < SURVEY_5G_COUNT; i++) if (survey_5g_channels[i] == ch) return i;
    return -1;
}

static int find_bssid(const uint8_t bssid[6])
{
    for (size_t i = 0; i < s_n_aps; i++) if (!memcmp(s_aps[i].bssid, bssid, 6)) return (int)i;
    return -1;
}

static void push_hist(survey_ap_t *ap, int8_t v)
{
    ap->hist[ap->hist_head] = v;
    ap->hist_head = (ap->hist_head + 1) % SURVEY_HIST;
    if (ap->hist_len < SURVEY_HIST) ap->hist_len++;
}

static uint8_t bw_mhz(wifi_bandwidth_t bw)
{
    switch (bw) {
    case WIFI_BW_HT40: return 40;
    case WIFI_BW80: return 80;
    case WIFI_BW160: case WIFI_BW80_BW80: return 160;
    default: return 20;
    }
}

/* Slot for a new network: free, else the stalest and weakest one. */
static survey_ap_t *alloc_slot(void)
{
    if (s_n_aps < SURVEY_MAX_APS) return &s_aps[s_n_aps++];
    survey_ap_t *victim = &s_aps[0];
    for (size_t i = 1; i < SURVEY_MAX_APS; i++) {
        survey_ap_t *c = &s_aps[i];
        if (c->last_scan < victim->last_scan || (c->last_scan == victim->last_scan && c->rssi < victim->rssi)) victim = c;
    }
    memset(victim, 0, sizeof(*victim));
    return victim;
}

static void merge_record(const wifi_ap_record_t *r, uint32_t scan_no)
{
    int i = find_bssid(r->bssid);
    survey_ap_t *ap = i >= 0 ? &s_aps[i] : alloc_slot();
    if (i < 0) memcpy(ap->bssid, r->bssid, 6);

    memcpy(ap->ssid, r->ssid, 32);
    ap->ssid[32] = 0;
    ap->channel = r->primary;
    ap->second = r->second == WIFI_SECOND_CHAN_ABOVE ? 1 : r->second == WIFI_SECOND_CHAN_BELOW ? -1 : 0;
    ap->bw_mhz = bw_mhz(r->bandwidth);
    ap->rssi = r->rssi;
    ap->auth = r->authmode;
    ap->phy = (r->phy_11b ? SURVEY_PHY_B : 0) | (r->phy_11g ? SURVEY_PHY_G : 0) | (r->phy_11n ? SURVEY_PHY_N : 0) |
              (r->phy_11a ? SURVEY_PHY_A : 0) | (r->phy_11ac ? SURVEY_PHY_AC : 0) | (r->phy_11ax ? SURVEY_PHY_AX : 0);
    ap->band5 = r->primary > 14;
    ap->last_scan = scan_no;
    push_hist(ap, r->rssi);
}

/* Which channels an AP's transmissions sit on, for the occupancy chart. */
static void add_footprint(const survey_ap_t *ap, const wifi_ap_record_t *r)
{
    if (!ap->band5) {
        /* 20 MHz is about four 5 MHz steps wide: count the primary and its
         * two neighbours each side as loaded, plus the HT40 secondary block. */
        int lo = ap->channel - 2, hi = ap->channel + 2;
        if (ap->bw_mhz >= 40 && ap->second) {
            int sec = ap->channel + 4 * ap->second;
            if (sec - 2 < lo) lo = sec - 2;
            if (sec + 2 > hi) hi = sec + 2;
        }
        for (int ch = lo; ch <= hi; ch++) if (ch >= 1 && ch <= 14) s_stats.load_2g[ch]++;
        return;
    }
    /* 5 GHz channels are 4 apart per 20 MHz. For 80/160 the beacon carries the
     * centre channel; for 40 the secondary offset says which side. */
    int centre = r->vht_ch_freq1;
    int half_steps;             /* channels covered = centre ± (half_steps*4 - 2) */
    switch (ap->bw_mhz) {
    case 160: half_steps = 4; break;
    case 80:  half_steps = 2; break;
    case 40:  half_steps = 1; centre = ap->channel + 2 * ap->second; break;
    default:  half_steps = 0; centre = ap->channel; break;
    }
    if (ap->bw_mhz >= 80 && centre == 0) { half_steps = 0; centre = ap->channel; }
    if (half_steps == 0) {
        int k = idx_5g(centre);
        if (k >= 0) s_stats.load_5g[k]++;
        return;
    }
    for (int ch = centre - (half_steps * 4 - 2); ch <= centre + (half_steps * 4 - 2); ch += 4) {
        int k = idx_5g(ch);
        if (k >= 0) s_stats.load_5g[k]++;
    }
}

static void log_to_sd(const wifi_ap_record_t *recs, uint16_t n, uint32_t scan_no)
{
#if CONFIG_SURVEY_SD_LOG
    if (!board_sd_mounted()) return;
    struct stat st;
    bool fresh = stat("/sdcard/survey.csv", &st) != 0 || st.st_size == 0;
    FILE *f = fopen("/sdcard/survey.csv", "a");
    if (!f) { ESP_LOGW(TAG, "cannot open survey.csv"); return; }
    if (fresh) fputs("scan,uptime_ms,bssid,ssid,band,channel,bw_mhz,rssi,auth,phy\n", f);
    uint32_t ms = (uint32_t)(esp_timer_get_time() / 1000);
    for (uint16_t i = 0; i < n; i++) {
        const wifi_ap_record_t *r = &recs[i];
        char ssid[33];
        memcpy(ssid, r->ssid, 32);
        ssid[32] = 0;
        for (char *p = ssid; *p; p++) if (*p == ',' || *p == '"' || *p == '\n') *p = '_';
        uint8_t phy = (r->phy_11b ? SURVEY_PHY_B : 0) | (r->phy_11g ? SURVEY_PHY_G : 0) | (r->phy_11n ? SURVEY_PHY_N : 0) |
                      (r->phy_11a ? SURVEY_PHY_A : 0) | (r->phy_11ac ? SURVEY_PHY_AC : 0) | (r->phy_11ax ? SURVEY_PHY_AX : 0);
        fprintf(f, "%lu,%lu,%02x:%02x:%02x:%02x:%02x:%02x,%s,%s,%u,%u,%d,%s,%s\n",
                (unsigned long)scan_no, (unsigned long)ms,
                r->bssid[0], r->bssid[1], r->bssid[2], r->bssid[3], r->bssid[4], r->bssid[5],
                ssid, r->primary > 14 ? "5" : "2.4", r->primary, bw_mhz(r->bandwidth), r->rssi,
                survey_auth_name(r->authmode), survey_phy_name(phy, r->primary > 14));
    }
    fclose(f);
#else
    (void)recs; (void)n; (void)scan_no;
#endif
}

/* ---- the scan loop ------------------------------------------------------ */

static void scan_task(void *arg)
{
    (void)arg;
    uint32_t scan_no = 0;
    for (;;) {
        scan_no++;
        board_led(0, 0, 6);
        wifi_scan_config_t cfg = {
            .channel = 0,           /* every channel the country allows, both bands */
            .show_hidden = true,
#if CONFIG_SURVEY_SCAN_PASSIVE
            .scan_type = WIFI_SCAN_TYPE_PASSIVE,
            .scan_time = { .passive = CONFIG_SURVEY_SCAN_PASSIVE_MS },
#else
            .scan_type = WIFI_SCAN_TYPE_ACTIVE,
            .scan_time = { .active = { .min = 40, .max = CONFIG_SURVEY_SCAN_ACTIVE_MAX_MS } },
#endif
        };
        int64_t t0 = esp_timer_get_time();
        esp_err_t err = esp_wifi_scan_start(&cfg, true);
        uint32_t took_ms = (uint32_t)((esp_timer_get_time() - t0) / 1000);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "scan failed: %s", esp_err_to_name(err));
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }

        uint16_t total = 0;
        esp_wifi_scan_get_ap_num(&total);
        uint16_t n = total > 128 ? 128 : total;
        wifi_ap_record_t *recs = calloc(n ? n : 1, sizeof(*recs));
        if (!recs) { esp_wifi_clear_ap_list(); continue; }
        if (esp_wifi_scan_get_ap_records(&n, recs) != ESP_OK) n = 0;

        if (survey_lock(2000)) {
            for (uint16_t i = 0; i < n; i++) merge_record(&recs[i], scan_no);

            /* Networks not heard this time get a gap in their history, and
             * are dropped once they have been quiet for long enough. */
            for (size_t i = 0; i < s_n_aps;) {
                survey_ap_t *ap = &s_aps[i];
                if (ap->last_scan != scan_no) push_hist(ap, SURVEY_NO_SIGNAL);
                if (scan_no - ap->last_scan >= CONFIG_SURVEY_AP_TTL_SCANS) {
                    s_aps[i] = s_aps[--s_n_aps];
                    continue;
                }
                i++;
            }

            memset(&s_stats, 0, sizeof(s_stats));
            s_stats.scan_no = scan_no;
            s_stats.scan_ms = took_ms;
            s_stats.n_aps = s_n_aps;
            for (uint16_t i = 0; i < n; i++) {
                const wifi_ap_record_t *r = &recs[i];
                int k = find_bssid(r->bssid);
                if (k < 0) continue;
                const survey_ap_t *ap = &s_aps[k];
                if (ap->band5) {
                    s_stats.n_5g++;
                    int c = idx_5g(ap->channel);
                    if (c >= 0) s_stats.on_5g[c]++;
                } else {
                    s_stats.n_2g++;
                    if (ap->channel >= 1 && ap->channel <= 14) s_stats.on_2g[ap->channel]++;
                }
                add_footprint(ap, r);
            }
            survey_unlock();
        }

        ESP_LOGI(TAG, "scan %lu: %u networks (%u on 2.4 GHz, %u on 5 GHz) in %lu ms",
                 (unsigned long)scan_no, n, s_stats.n_2g, s_stats.n_5g, (unsigned long)took_ms);
        log_to_sd(recs, n, scan_no);
        free(recs);

        if (s_stats.n_5g) board_led(0, 6, 8); else board_led(8, 4, 0);
        vTaskDelay(pdMS_TO_TICKS(CONFIG_SURVEY_SCAN_GAP_MS));
    }
}

/* ---- public ------------------------------------------------------------- */

void survey_start(void)
{
    s_lock = xSemaphoreCreateMutex();

    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_country_code(CONFIG_SURVEY_COUNTRY, false));
    err = esp_wifi_set_band_mode(WIFI_BAND_MODE_AUTO);
    if (err != ESP_OK) ESP_LOGW(TAG, "band mode AUTO: %s (2.4 GHz only?)", esp_err_to_name(err));
    ESP_ERROR_CHECK(esp_wifi_start());

    xTaskCreate(scan_task, "survey", 8192, NULL, 4, NULL);
}

bool survey_lock(uint32_t timeout_ms)
{
    return xSemaphoreTake(s_lock, pdMS_TO_TICKS(timeout_ms)) == pdTRUE;
}

void survey_unlock(void) { xSemaphoreGive(s_lock); }

const survey_ap_t *survey_aps(size_t *count)
{
    *count = s_n_aps;
    return s_aps;
}

const survey_stats_t *survey_stats(void) { return &s_stats; }

const char *survey_auth_name(wifi_auth_mode_t a)
{
    switch (a) {
    case WIFI_AUTH_OPEN: return "open";
    case WIFI_AUTH_WEP: return "WEP";
    case WIFI_AUTH_WPA_PSK: return "WPA";
    case WIFI_AUTH_WPA2_PSK: return "WPA2";
    case WIFI_AUTH_WPA_WPA2_PSK: return "WPA/2";
    case WIFI_AUTH_WPA3_PSK: return "WPA3";
    case WIFI_AUTH_WPA2_WPA3_PSK: return "WPA2/3";
    case WIFI_AUTH_OWE: return "OWE";
    case WIFI_AUTH_WPA2_ENTERPRISE: return "WPA2-E";
    case WIFI_AUTH_WPA3_ENTERPRISE:
    case WIFI_AUTH_WPA2_WPA3_ENTERPRISE:
    case WIFI_AUTH_WPA3_ENT_192: return "WPA3-E";
    case WIFI_AUTH_WPA_ENTERPRISE: return "WPA-E";
    default: return "?";
    }
}

const char *survey_phy_name(uint8_t phy, bool band5)
{
    if (phy & SURVEY_PHY_AX) return "ax";
    if (phy & SURVEY_PHY_AC) return "ac";
    if (phy & SURVEY_PHY_N) return "n";
    if (band5) return "a";
    if (phy & SURVEY_PHY_G) return "g";
    return "b";
}
