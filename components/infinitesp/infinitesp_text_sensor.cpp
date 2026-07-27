#include "infinitesp_text_sensor.h"
#include <cctype>
#include <cstdlib>

namespace esphome {
namespace infinitesp {

// Fault source byte is the device bus address; the high nibble is the device
// class (0x2x thermostat/UI, 0x4x IDU/furnace, 0x5x ODU, 0x6x zone controller).
// Matches Infinitude and the device-class convention. Confirmed against live
// 4202 data (src=0x20 thermostat, src=0x60 zone controller).
static const char *fault_source_name(uint8_t source) {
  switch (source >> 4) {
    case 0x2: return "UI";   // thermostat
    case 0x4: return "IDU";  // indoor unit / furnace
    case 0x5: return "ODU";  // outdoor unit
    case 0x6: return "ZC";   // zone controller
    default:  return "?";
  }
}

// Known fault-code descriptions, cross-checked against the thermostat's fault
// history screen. Extend as more codes are confirmed. Returns nullptr if unknown
// (callers then show just the numeric code).
static const char *fault_code_name(uint8_t code) {
  switch (code) {
    case 16:  return "Comm Error";        // ZC/zone communication error (notice)
    case 171: return "Sensor Zn2 Comm";   // Smart Sensor Zone 2 COMM Fault
    case 186: return "SAM Comm Fault";     // SAM Communication Fault
    default:  return nullptr;
  }
}

void InfinitESPTextSensor::on_register_update(uint8_t device_addr, uint16_t register_key) {
  // Hold state display: "until HH:MM PM", "Permanent", or "Schedule"
  if (sensor_type_ == "hold_state") {
    if (register_key != REG_SAM_ZONES)
      return;
    auto *data = parent_->get_register(parent_->get_sam_address(), REG_SAM_ZONES);
    if (!data || data->size() < REG3B03_HOLD_DURATIONS + zone_ * 2)
      return;

    uint8_t idx = zone_ - 1;
    if (!(data->at(REG3B03_ACTIVE_ZONES) & (1 << idx)))
      return;

    uint16_t hold_dur = parent_->get_zone_hold_duration(zone_);

    if (hold_dur == 0) {
      publish_state("Schedule");
    } else if (hold_dur >= InfinitESPComponent::HOLD_PERMANENT) {
      publish_state("Hold - Permanent");
    } else {
      std::string end = parent_->format_hold_end(hold_dur);
      if (!end.empty())
        publish_state("Hold until " + end);
      else
        publish_state("Hold " + std::to_string(hold_dur) + " min");
    }
    return;
  }

  // Zone name from SAM 3B03 register
  if (sensor_type_ == "zone_name") {
    if (register_key != REG_SAM_ZONES)
      return;

    auto *data = parent_->get_register(parent_->get_sam_address(), REG_SAM_ZONES);
    if (!data || data->size() < REG3B03_SIZE)
      return;

    uint8_t idx = zone_ - 1;
    if (!(data->at(REG3B03_ACTIVE_ZONES) & (1 << idx)))
      return;

    uint16_t name_offset = REG3B03_ZONE_NAMES + (idx * 12);
    std::string name;
    for (int i = 0; i < 12; i++) {
      char c = (char) data->at(name_offset + i);
      if (c == 0)
        break;
      name += c;
    }
    // Trim trailing spaces
    while (!name.empty() && name.back() == ' ') {
      name.pop_back();
    }

    if (!name.empty()) {
      publish_state(name);
    }
    return;
  }

  // Thermostat WiFi SSID from 4608
  if (sensor_type_ == "tstat_ssid") {
    if (register_key != REG_TSTAT_WIFI)
      return;
    auto *data = parent_->get_register(ADDR_THERMOSTAT, REG_TSTAT_WIFI);
    if (!data || data->size() < 25)
      return;
    publish_state(extract_cstr(*data, 24));
    return;
  }

  // Thermostat WiFi hostname from 4608
  if (sensor_type_ == "tstat_hostname") {
    if (register_key != REG_TSTAT_WIFI)
      return;
    auto *data = parent_->get_register(ADDR_THERMOSTAT, REG_TSTAT_WIFI);
    if (!data || data->size() < 140)
      return;
    publish_state(extract_cstr(*data, 139));
    return;
  }

  // Thermostat WiFi MAC address from 4608
  if (sensor_type_ == "tstat_wifi_mac") {
    if (register_key != REG_TSTAT_WIFI)
      return;
    auto *data = parent_->get_register(ADDR_THERMOSTAT, REG_TSTAT_WIFI);
    if (!data || data->size() < 5)
      return;
    publish_state(extract_cstr(*data, 4));
    return;
  }

  // Thermostat cloud host from 4609
  if (sensor_type_ == "tstat_cloud_host") {
    if (register_key != REG_TSTAT_CLOUD)
      return;
    auto *data = parent_->get_register(ADDR_THERMOSTAT, REG_TSTAT_CLOUD);
    if (!data || data->empty())
      return;
    publish_state(extract_cstr(*data, 0));
    return;
  }

  // Thermostat proxy server IP from 4609
  if (sensor_type_ == "tstat_proxy_server") {
    if (register_key != REG_TSTAT_CLOUD)
      return;
    auto *data = parent_->get_register(ADDR_THERMOSTAT, REG_TSTAT_CLOUD);
    if (!data || data->size() < 68)
      return;
    publish_state(extract_cstr(*data, 67));
    return;
  }

  // Dealer name from 460A
  if (sensor_type_ == "tstat_dealer_name") {
    if (register_key != REG_TSTAT_DEALER)
      return;
    auto *data = parent_->get_register(ADDR_THERMOSTAT, REG_TSTAT_DEALER);
    if (!data || data->empty())
      return;
    publish_state(extract_cstr(*data, 0));
    return;
  }

  // Dealer brand from 460A
  if (sensor_type_ == "tstat_dealer_brand") {
    if (register_key != REG_TSTAT_DEALER)
      return;
    auto *data = parent_->get_register(ADDR_THERMOSTAT, REG_TSTAT_DEALER);
    if (!data || data->size() < 51)
      return;
    publish_state(extract_cstr(*data, 50));
    return;
  }

  // Dealer URL from 460A
  if (sensor_type_ == "tstat_dealer_url") {
    if (register_key != REG_TSTAT_DEALER)
      return;
    auto *data = parent_->get_register(ADDR_THERMOSTAT, REG_TSTAT_DEALER);
    if (!data || data->size() < 71)
      return;
    publish_state(extract_cstr(*data, 70));
    return;
  }

  // Comfort profile summary from 400A
  if (sensor_type_ == "comfort_profile") {
    if (register_key != REG_TSTAT_COMFORT)
      return;
    auto *data = parent_->get_register(ADDR_THERMOSTAT, REG_TSTAT_COMFORT);
    if (!data || data->size() < COMFORT_ACTIVITY_COUNT * COMFORT_ENTRY_SIZE)
      return;

    const char *names[] = {"home", "away", "sleep", "wake", "manual"};
    const char *fan_names[] = {"off", "low", "med", "high"};
    // Show temperatures in both °C and °F for universal readability
    // (HA can't auto-convert text sensor strings)
    std::string result;
    for (uint8_t i = 0; i < COMFORT_ACTIVITY_COUNT; i++) {
      uint8_t base = i * COMFORT_ENTRY_SIZE;
      float ht_c = parent_->comfort_byte_to_celsius((*data)[base + 0]);
      float cl_c = parent_->comfort_byte_to_celsius((*data)[base + 1]);
      float ht_f = ht_c * 9.0f / 5.0f + 32.0f;
      float cl_f = cl_c * 9.0f / 5.0f + 32.0f;
      if (i > 0)
        result += "; ";
      char buf[80];
      snprintf(buf, sizeof(buf), "%s: ht=%.0f\xc2\xb0" "F/%.1f\xc2\xb0" "C cl=%.0f\xc2\xb0" "F/%.1f\xc2\xb0" "C fan=%s",
               names[i],
               ht_f, ht_c, cl_f, cl_c,
               (*data)[base + 2] < 4 ? fan_names[(*data)[base + 2]] : "?");
      result += buf;
    }
    publish_state(result);
    return;
  }

  // --- Fault history from 4202 ---
  // Layout: 10 entries x 7 bytes [code, source, hour, minute, days_be16, status]
  //   + 2 trailing bytes = CURRENT day-count (days since install).
  // days_be16 is a per-device day-count; a fault is (trailing - days) days ago.
  //   -> absolute date via parent_->fault_date_str() (needs time: source).
  // status: bit7 = severity class (0 = hard FAULT, 1 = notice/comm-error;
  //   matches the thermostat's "fault" indicator), bits0-6 = occurrence count.
  //
  // "fault_history"     = compact one-line-per-entry summary (kept < 255 chars
  //                       so Home Assistant accepts the state).
  // "fault_1".."fault_10" = one verbose entry each (1 = most recent), for a
  //                       Markdown card that needs no length limit.
  bool is_summary = (sensor_type_ == "fault_history");
  bool is_entry = (sensor_type_.compare(0, 6, "fault_") == 0 && !is_summary);
  if (is_summary || is_entry) {
    if (register_key != REG_TSTAT_FAULTS)
      return;
    auto *data = parent_->get_register(ADDR_THERMOSTAT, REG_TSTAT_FAULTS);
    if (!data || data->size() < 70)
      return;

    uint16_t trailing = data->size() >= 72
                            ? (((uint16_t) (*data)[70] << 8) | (*data)[71])
                            : 0;  // 0 -> fault_date_str reports age from 0

    auto decode_entry = [&](int i, bool verbose) -> std::string {
      uint8_t base = i * 7;
      uint8_t code = (*data)[base + 0];
      uint8_t source = (*data)[base + 1];
      uint8_t hour = (*data)[base + 2];
      uint8_t minute = (*data)[base + 3];
      uint16_t days = ((uint16_t) (*data)[base + 4] << 8) | (*data)[base + 5];
      uint8_t status = (*data)[base + 6];
      if (code == 0 && source == 0 && days == 0)
        return "";  // empty slot
      bool is_fault = !(status & 0x80);  // bit7=0 -> hard fault
      uint8_t occ = status & 0x7F;
      std::string date = parent_->fault_date_str(trailing, days);
      const char *sev = is_fault ? "FAULT" : "notice";
      const char *src = fault_source_name(source);
      const char *name = fault_code_name(code);
      char buf[96];
      if (verbose) {
        // e.g. "FAULT SAM Comm Fault (186) UI 2026-07-17 09:54 x3"
        if (name)
          snprintf(buf, sizeof(buf), "%s %s (%d) %s %s %02d:%02d x%d",
                   sev, name, code, src, date.c_str(), hour, minute, occ);
        else
          snprintf(buf, sizeof(buf), "%s code %d %s %s %02d:%02d x%d",
                   sev, code, src, date.c_str(), hour, minute, occ);
      } else {
        // compact: "F186 UI 2026-07-17 x3"  (F=fault, n=notice)
        snprintf(buf, sizeof(buf), "%c%d %s %s x%d",
                 is_fault ? 'F' : 'n', code, src, date.c_str(), occ);
      }
      return std::string(buf);
    };

    if (is_entry) {
      int idx = atoi(sensor_type_.c_str() + 6);  // "fault_3" -> 3
      if (idx < 1 || idx > 10)
        return;
      std::string s = decode_entry(idx - 1, /*verbose=*/true);
      publish_state(s.empty() ? "—" : s);
      return;
    }

    // Summary: join entries, guard the HA 255-char state limit.
    std::string result;
    for (int i = 0; i < 10; i++) {
      std::string line = decode_entry(i, /*verbose=*/false);
      if (line.empty())
        continue;
      std::string next = result.empty() ? line : result + "\n" + line;
      if (next.size() > 250) {  // leave headroom under HA's 255 cap
        result += "\n…";
        break;
      }
      result = next;
    }
    if (result.empty())
      result = "No faults";
    publish_state(result);
    return;
  }


  // Device model from 0104 DeviceInfo (Model field at offset 64, 20 bytes).
  // Requires device_address to be set — each physical device needs its own sensor
  // (0x50 ODU, 0x40 furnace/air-handler, 0x60 zone controller).
  if (sensor_type_ == "device_model") {
    if (register_key != REG_DEVICE_INFO)
      return;
    if (target_device_addr_ != 0 && device_addr != target_device_addr_)
      return;
    auto *data = parent_->get_register(device_addr, REG_DEVICE_INFO);
    if (!data || data->size() < REG_DEVINFO_MODEL_OFFSET + REG_DEVINFO_MODEL_LEN)
      return;
    std::string model;
    for (uint8_t i = 0; i < REG_DEVINFO_MODEL_LEN; i++) {
      char c = (char) (*data)[REG_DEVINFO_MODEL_OFFSET + i];
      if (c == '\0')
        break;
      model += c;
    }
    // trim trailing spaces
    while (!model.empty() && model.back() == ' ')
      model.pop_back();
    if (!model.empty())
      publish_state(model);
    return;
  }

  // Manufacture date derived from 0104 serial number
  // Carrier serial format: first 2 digits = week (01-52), next 2 digits = year (00-99)
  // Requires device_address to be set — each physical device needs its own sensor
  if (sensor_type_ == "manufacture_date") {
    if (register_key != REG_DEVICE_INFO)
      return;
    if (target_device_addr_ != 0 && device_addr != target_device_addr_)
      return;
    auto *data = parent_->get_register(device_addr, REG_DEVICE_INFO);
    if (!data || data->size() < 100)
      return;

    // Serial starts at offset 96, extract first 4 digits
    const uint8_t *serial = data->data() + 96;
    if (!std::isdigit(serial[0]) || !std::isdigit(serial[1]) ||
        !std::isdigit(serial[2]) || !std::isdigit(serial[3]))
      return;

    uint8_t week = (serial[0] - '0') * 10 + (serial[1] - '0');
    uint8_t year_short = (serial[2] - '0') * 10 + (serial[3] - '0');
    if (week < 1 || week > 52)
      return;

    // Carrier used 2-digit years. 00-39 → 2000-2039, 40-99 → 1940-1999
    uint16_t year = (year_short < 40) ? (2000 + year_short) : (1900 + year_short);

    // Week → approximate month (midpoint of week)
    static const uint16_t month_cumulative[] = {0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334};
    uint16_t day_of_year = (week - 1) * 7 + 3;  // midpoint of the week
    bool leap = (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0));
    if (leap && day_of_year > 59) day_of_year++;  // shift past Feb 29
    const char *month_names[] = {"January", "February", "March", "April", "May", "June",
                                 "July", "August", "September", "October", "November", "December"};
    uint8_t month = 0;
    for (uint8_t m = 1; m < 12; m++) {
      if (day_of_year < month_cumulative[m])
        break;
      month = m;
    }

    char buf[24];
    snprintf(buf, sizeof(buf), "%s %04u", month_names[month], year);
    publish_state(buf);
    return;
  }
}

} // namespace infinitesp
} // namespace esphome
