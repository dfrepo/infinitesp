#include "infinitesp_select.h"
#include <cmath>

namespace esphome {
namespace infinitesp {

// Index must match SYSMODE_* constants: HEAT=0, COOL=1, AUTO=2, EHEAT=3, OFF=4
static const char *const SYSTEM_MODES[] = {"heat", "cool", "auto", "emergency_heat", "off"};
static const char *const FAN_MODES[] = {"auto", "low", "med", "high"};
// Index 0..3 map directly to COMFORT_HOME/AWAY/SLEEP/WAKE (apply_activity index);
// index 4 = "hold" (permanent hold on current setpoints); index 5 = "schedule"
// (cancel hold, resume programmed schedule).
static const char *const PROFILE_OPTS[] = {"home", "away", "sleep", "wake", "hold", "schedule"};
static const uint8_t PROFILE_HOLD = 4;
static const uint8_t PROFILE_SCHEDULE = 5;

void InfinitESPSelect::control(const std::string &value) {
  if (select_type_ == "system_mode") {
    // Map string back to SYSMODE_* constant
    uint8_t mode = SYSMODE_OFF;  // default
    for (uint8_t i = 0; i < 5; i++) {
      if (value == SYSTEM_MODES[i]) {
        mode = i;
        break;
      }
    }
    parent_->set_system_mode(mode);
    current_mode_ = mode;
  } else if (select_type_ == "fan_mode") {
    for (uint8_t i = 0; i < 4; i++) {
      if (value == FAN_MODES[i]) {
        parent_->set_zone_fan(zone_, i);
        current_mode_ = i;
        break;
      }
    }
  } else if (select_type_ == "profile") {
    for (uint8_t i = 0; i < 6; i++) {
      if (value == PROFILE_OPTS[i]) {
        if (i == PROFILE_SCHEDULE) {
          // Cancel the hold -> resume the programmed schedule.
          parent_->set_zone_hold(zone_, 0);
        } else if (i == PROFILE_HOLD) {
          // Hold the CURRENT setpoints indefinitely (manual permanent hold).
          parent_->set_zone_hold(zone_, InfinitESPComponent::HOLD_PERMANENT);
        } else {
          // home/away/sleep/wake -> apply that comfort activity as a permanent hold.
          parent_->apply_activity(zone_, i, InfinitESPComponent::HOLD_PERMANENT);
        }
        current_mode_ = i;
        break;
      }
    }
  }
  publish_state(value);
}

void InfinitESPSelect::on_register_update(uint8_t device_addr, uint16_t register_key) {
  if (select_type_ == "system_mode" && register_key == REG_SAM_STATE) {
    auto *data = parent_->get_register(parent_->get_sam_address(), REG_SAM_STATE);
    if (data && data->size() >= REG3B02_STAGMODE + 1) {
      uint8_t stagmode = data->at(REG3B02_STAGMODE);
      uint8_t mode = stagmode & 0x0F;
      if (mode != current_mode_ && mode <= 4) {
        current_mode_ = mode;
        publish_state(SYSTEM_MODES[mode]);
      }
    }
  } else if (select_type_ == "fan_mode" && register_key == REG_SAM_ZONES) {
    auto *data = parent_->get_register(parent_->get_sam_address(), REG_SAM_ZONES);
    if (data && data->size() >= REG3B03_FAN_MODES + 8) {
      uint8_t idx = zone_ - 1;
      if (data->at(REG3B03_ACTIVE_ZONES) & (1 << idx)) {
        uint8_t fan = data->at(REG3B03_FAN_MODES + idx);
        if (fan != current_mode_ && fan <= 3) {
          current_mode_ = fan;
          publish_state(FAN_MODES[fan]);
        }
      }
    }
  } else if (select_type_ == "profile" && register_key == REG_SAM_ZONES) {
    auto *data = parent_->get_register(parent_->get_sam_address(), REG_SAM_ZONES);
    if (!data || data->size() < REG3B03_COOL_SETPOINTS + 8)
      return;
    uint8_t idx = zone_ - 1;
    if (!(data->at(REG3B03_ACTIVE_ZONES) & (1 << idx)))
      return;

    // Determine the profile: no hold -> "schedule"; hold active -> match current
    // setpoints+fan against the comfort profiles (400A) to recover the activity.
    // Mirrors the climate preset-inference. A hold whose setpoints do not match
    // any home/away/sleep/wake activity is a manual "hold" (custom setpoints held).
    uint8_t target = PROFILE_SCHEDULE;
    uint16_t hold_dur = parent_->get_zone_hold_duration(zone_);
    if (hold_dur > 0) {
      target = PROFILE_HOLD;  // held on custom setpoints unless it matches an activity
      uint8_t heat = data->at(REG3B03_HEAT_SETPOINTS + idx);
      uint8_t cool = data->at(REG3B03_COOL_SETPOINTS + idx);
      uint8_t fan = data->at(REG3B03_FAN_MODES + idx);
      auto *comfort = parent_->get_register(ADDR_THERMOSTAT, REG_TSTAT_COMFORT);
      if (comfort && comfort->size() >= COMFORT_ACTIVITY_COUNT * COMFORT_ENTRY_SIZE) {
        float sp_ht_c = parent_->setpoint_to_celsius(heat);
        float sp_cl_c = parent_->setpoint_to_celsius(cool);
        for (uint8_t a = 0; a <= COMFORT_WAKE; a++) {  // only home/away/sleep/wake
          uint8_t base = a * COMFORT_ENTRY_SIZE;
          float ht_c = parent_->comfort_byte_to_celsius((*comfort)[base + 0]);
          float cl_c = parent_->comfort_byte_to_celsius((*comfort)[base + 1]);
          if (fabsf(ht_c - sp_ht_c) < 0.3f && fabsf(cl_c - sp_cl_c) < 0.3f &&
              (*comfort)[base + 2] == fan) {
            target = a;
            break;
          }
        }
      }
    }
    if (target != current_mode_) {
      current_mode_ = target;
      publish_state(PROFILE_OPTS[target]);
    }
  }
}

} // namespace infinitesp
} // namespace esphome
