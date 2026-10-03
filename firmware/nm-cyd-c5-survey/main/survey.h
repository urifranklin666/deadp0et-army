#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_wifi_types.h"

#define SURVEY_MAX_APS      64
#define SURVEY_HIST         60      /* RSSI samples kept per network, one per scan */
#define SURVEY_NO_SIGNAL    INT8_MIN/* history marker: not heard in that scan */
#define SURVEY_5G_COUNT     28

/* PHY bits */
#define SURVEY_PHY_B   (1 << 0)
#define SURVEY_PHY_G   (1 << 1)
#define SURVEY_PHY_N   (1 << 2)
#define SURVEY_PHY_A   (1 << 3)
#define SURVEY_PHY_AC  (1 << 4)
#define SURVEY_PHY_AX  (1 << 5)

typedef struct {
    uint8_t  bssid[6];
    char     ssid[33];
    uint8_t  channel;       /* primary */
    int8_t   second;        /* HT40 secondary: -1 below, 0 none, +1 above */
    uint8_t  bw_mhz;        /* 20, 40, 80, 160 */
    int8_t   rssi;          /* last heard */
    wifi_auth_mode_t auth;
    uint8_t  phy;           /* SURVEY_PHY_* */
    bool     band5;
    uint32_t last_scan;     /* scan number it was last heard in */
    int8_t   hist[SURVEY_HIST];
    uint8_t  hist_len;
    uint8_t  hist_head;     /* next write position */
} survey_ap_t;

typedef struct {
    uint32_t scan_no;
    uint32_t scan_ms;       /* duration of the last scan */
    uint16_t n_aps;         /* networks in the table */
    uint16_t n_2g, n_5g;    /* heard in the last scan */
    uint8_t  on_2g[15];     /* APs whose primary channel is ch, index = ch (1..14) */
    uint8_t  load_2g[15];   /* APs whose channel footprint covers ch */
    uint8_t  on_5g[SURVEY_5G_COUNT];   /* index = position in survey_5g_channels */
    uint8_t  load_5g[SURVEY_5G_COUNT];
} survey_stats_t;

extern const uint8_t survey_5g_channels[SURVEY_5G_COUNT];

/* Start Wi-Fi and the scanning task. */
void survey_start(void);

/* The table and stats are only valid while locked. Readers copy and release. */
bool survey_lock(uint32_t timeout_ms);
void survey_unlock(void);
const survey_ap_t *survey_aps(size_t *count);
const survey_stats_t *survey_stats(void);

const char *survey_auth_name(wifi_auth_mode_t a);
const char *survey_phy_name(uint8_t phy, bool band5);
