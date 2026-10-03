# NM-CYD-C5 Wi-Fi survey

Dual-band Wi-Fi site survey for the [RockBase NM-CYD-C5](https://github.com/RockBase-iot/NM-CYD-C5),
the ESP32-C5 version of the Cheap Yellow Display. It scans 2.4 GHz and 5 GHz
back to back, forever, and shows what it hears on the 2.8" touchscreen:

- **Networks**: every network heard, strongest first, with band, channel,
  RSSI and security. Tap one to track it.
- **Channels**: a bar per channel for each band. Bright bars are networks on
  that primary channel; dim bars count every network whose 20/40/80/160 MHz
  footprint covers it, which is what actually crowds a channel.
- **Track**: the tapped network's RSSI over the last 60 scans, with min,
  average and max. Walk around with it to find dead spots or test roaming.

With a microSD card inserted, every scan is appended to `/sdcard/survey.csv`
(scan number, uptime, BSSID, SSID, band, channel, bandwidth, RSSI, security,
PHY). The WS2812 goes blue while scanning, then cyan if any 5 GHz network was
heard and amber if not.

It never connects to anything. Active scans send probe requests; set
`Scan type` to passive in menuconfig to transmit nothing at all.

This is a standalone ESP-IDF project. It shares the repository with
deadp0et but nothing else.

## Build

ESP-IDF 5.5 or later (the ESP32-C5 is stable from 5.5). Components come from
the Espressif registry on first build.

```bash
cd firmware/nm-cyd-c5-survey
idf.py set-target esp32c5
idf.py menuconfig          # at least: NM-CYD-C5 Wi-Fi Survey -> Regulatory country code
idf.py -p /dev/ttyUSB0 flash monitor
```

Use the USB-C port labelled for the CH340 UART. The other port is the C5's
own USB Serial/JTAG, which also works for flashing but needs
`idf.py -p` pointed at the ACM device.

## Settings

Everything lives under **NM-CYD-C5 Wi-Fi Survey** in `idf.py menuconfig`.

**Country code.** Decides which 5 GHz channels the radio may probe. Set it to
where you are. The default is `US`; `01` is the world-safe set with fewer
5 GHz channels.

**Display.** The board ships with an ST7789; RockBase documents an ILI9341
variant, selectable here. If red and blue are swapped, flip `BGR`. If the
image looks like a negative, flip `Invert colours`. If it is rotated or
mirrored, adjust `Swap X/Y`, `Mirror X`, `Mirror Y`.

**Touch calibration.** Resistive panels differ enough that a fixed mapping
misses buttons. Enable `Log raw and mapped touch points`, flash, tap each
edge of the screen, and copy the raw X and Y values at the left, right, top
and bottom edges into the four `Raw ...` fields. If taps land swapped or
mirrored relative to the screen, adjust the touch `Swap X/Y` and `Mirror`
flags; they are independent of the display ones.

**Pins** match the RockBase pinout and should not need changing: SPI on
6/7/2, LCD CS 23, DC 24, backlight 25, touch CS 1, microSD CS 10, WS2812 27.
The LCD reset is tied to the board reset.

## How it is built

- `main/board.c`: one SPI bus (SPI2) shared by the LCD, the XPT2046 and the
  microSD, each on its own chip select. esp_lcd and sdspi both take the bus
  lock so they interleave; a burst of SD writes briefly stalls the display.
  LVGL runs through `esp_lvgl_port` with two 320x24 RGB565 draw buffers in
  internal DMA RAM.
- `main/survey.c`: the scan task. Each pass is one blocking
  `esp_wifi_scan_start` across every channel the country allows on both
  bands (`WIFI_BAND_MODE_AUTO`). Results merge into a table keyed by BSSID
  with a 60-sample RSSI history per network; networks go quiet for a few
  scans before they are dropped. Channel footprints use the beacon's centre
  frequency for 80/160 MHz and the secondary-channel offset for 40 MHz.
- `main/ui.c`: the three tabs. A 500 ms LVGL timer copies the table under
  its lock and redraws only when a new scan has landed. Nothing in the scan
  task touches LVGL.

An active scan of both bands takes about 4 to 6 seconds with the default
120 ms per-channel dwell. Passive scans take roughly three times longer.

## Known limits

- One touch point, no gestures; the tab bar is the navigation.
- The table holds 64 networks. In a dense building the weakest and stalest
  are evicted first.
- Hidden networks are listed as `<hidden>` with their BSSID visible on the
  Track tab.
- This build was compile-tested against ESP-IDF v5.5.5 with LVGL 9.3.0,
  esp_lvgl_port 2.9.0, esp_lcd_touch 1.2.1, esp_lcd_touch_xpt2046 1.0.6
  and led_strip 3.0.3, but has not yet run on the hardware. The display
  orientation, colour order and touch calibration defaults are the parts
  most likely to need a menuconfig tweak on first boot.
