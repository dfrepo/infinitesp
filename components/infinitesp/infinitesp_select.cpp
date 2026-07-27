#include "infinitesp_select.h"
#include <cmath>

namespace esphome {
namespace infinitesp {

// Index must match SYSMODE_* constants: HEAT=0, COOL=1, AUTO=2, EHEAT=3, OFF=4
static const char *const SYSTEM_MODES[] = {"heat", "cool", "auto", "emergency_heat", "off"};
static const char *const FAN_MODES[] = {"auto", "low", "med", "high"};
// Comfort activities — index aligns with COMFORT_HOME..COMFORT_MANUAL (0..4).
// home/away/sleep/wake are schedule activities (writable = apply + hold);
// "manual" is the custom-setpoints state (read-only — you enter it by changing a
// setpoint, it has no preset to apply).
static const char *const ACTIVITY_OPTS[] = {"home", "away", "sleep", "wake", "manual"};
// Hold mode — the orthogonal axis: following the schedule, or holding.
// "hold_until" is READBACK-ONLY (a finite/timed hold set on the physical
// thermostat); the thermostat ignores timed-hold writes from the SAM
// (verified 2026-06-30), so selecting it from HA cannot take effect.
static const char *const HOLD_MODE_OPTS[] = {"schedule", "hold", "hold_until"};
static const uint8_t HOLD_MODE_SCHEDULE = 0;
static const uint8_t HOLD_MODE_HOLD = 1;
static const uint8_t HOLD_MODE_HOLD_UNTIL = 2;
// System-wide vacation: index 0=off, 1=on. Readback from 0x0420 bit 0x20.
static const char *const VACATION_OPTS[] = {"off", "on"};

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
  } else if (select_type_ == "activity") {
    // Applying an activity writes its comfort setpoints+fan (from 400A) and holds
    // it permanently — the thermostat treats a setpoint change as a hold. "manual"
    // has no preset setpoints, so it's read-only (ignored on write).
    for (uint8_t i = 0; i <= COMFORT_WAKE; i++) {  // home/away/sleep/wake
      if (value == ACTIVITY_OPTS[i]) {
        parent_->apply_activity(zone_, i, InfinitESPComponent::HOLD_PERMANENT);
        current_mode_ = i;
        break;
      }
    }
  } else if (select_type_ == "hold_mode") {
    // "hold_until" is readback-only: the thermostat ignores timed-hold writes
    // from the SAM, so treat a UI pick of it as a no-op — re-publish the actual
    // current hold state instead of sending an ignored write.
    if (value == HOLD_MODE_OPTS[HOLD_MODE_HOLD_UNTIL]) {
      on_register_update(parent_->get_sam_address(), REG_SAM_ZONES);
      return;
    }
    for (uint8_t i = 0; i < 2; i++) {
      if (value == HOLD_MODE_OPTS[i]) {
        if (i == HOLD_MODE_SCHEDULE)
          parent_->set_zone_hold(zone_, 0);  // cancel hold -> resume schedule
        else
          parent_->set_zone_hold(zone_, InfinitESPComponent::HOLD_PERMANENT);  // hold current
        current_mode_ = i;
        break;
      }
    }
  } else if (select_type_ == "vacation") {
    // "off" CANCELS vacation via a 3B04 push (set_vacation_days(0)) — verified to
    // cancel even a thermostat-initiated vacation. Activating ("on") from HA needs
    // a duration and is a future TODO, so it's a no-op here. Re-read the real bus
    // state instead of optimistically showing the picked value.
    if (value == "off")
      parent_->set_vacation_days(0);
    on_register_update(ADDR_THERMOSTAT, REG_TSTAT_STATUS);
    return;
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
  } else if (select_type_ == "activity" && register_key == REG_SAM_ZONES) {
    // The current comfort activity = which comfort profile the zone's current
    // setpoints+fan match (400A), whether held or schedule-driven. No match -> the
    // custom "manual" activity. Independent of hold state (that's hold_mode).
    auto *data = parent_->get_register(parent_->get_sam_address(), REG_SAM_ZONES);
    if (!data || data->size() < REG3B03_COOL_SETPOINTS + 8)
      return;
    uint8_t idx = zone_ - 1;
    if (!(data->at(REG3B03_ACTIVE_ZONES) & (1 << idx)))
      return;
    uint8_t heat = data->at(REG3B03_HEAT_SETPOINTS + idx);
    uint8_t cool = data->at(REG3B03_COOL_SETPOINTS + idx);
    uint8_t fan = data->at(REG3B03_FAN_MODES + idx);
    uint8_t target = COMFORT_MANUAL;  // default if nothing else matches
    auto *comfort = parent_->get_register(ADDR_THERMOSTAT, REG_TSTAT_COMFORT);
    if (comfort && comfort->size() >= COMFORT_ACTIVITY_COUNT * COMFORT_ENTRY_SIZE) {
      float sp_ht_c = parent_->setpoint_to_celsius(heat);
      float sp_cl_c = parent_->setpoint_to_celsius(cool);
      for (uint8_t a = 0; a <= COMFORT_WAKE; a++) {  // home/away/sleep/wake
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
    if (target != current_mode_) {
      current_mode_ = target;
      publish_state(ACTIVITY_OPTS[target]);
    }
  } else if (select_type_ == "hold_mode" && register_key == REG_SAM_ZONES) {
    // Raw hold axis: schedule (no hold) / hold (permanent) / hold_until (timed).
    auto *data = parent_->get_register(parent_->get_sam_address(), REG_SAM_ZONES);
    if (!data || data->size() < REG3B03_HOLD_DURATIONS + zone_ * 2)
      return;
    uint8_t idx = zone_ - 1;
    if (!(data->at(REG3B03_ACTIVE_ZONES) & (1 << idx)))
      return;
    uint16_t dur = parent_->get_zone_hold_duration(zone_);
    uint8_t target = dur == 0 ? HOLD_MODE_SCHEDULE
                     : dur >= InfinitESPComponent::HOLD_PERMANENT ? HOLD_MODE_HOLD
                                                                  : HOLD_MODE_HOLD_UNTIL;
    if (target != current_mode_) {
      current_mode_ = target;
      publish_state(HOLD_MODE_OPTS[target]);
    }
  } else if (select_type_ == "vacation" && register_key == REG_TSTAT_STATUS) {
    // Vacation active flag from the thermostat's 0x0420 status broadcast (bit 0x20).
    auto *data = parent_->get_register(ADDR_THERMOSTAT, REG_TSTAT_STATUS);
    if (data && data->size() >= 3) {
      uint8_t on = ((*data)[2] & REG0420_VACATION_BIT) ? 1 : 0;
      if (on != current_mode_) {
        current_mode_ = on;
        publish_state(VACATION_OPTS[on]);
      }
    }
  }
}

} // namespace infinitesp
} // namespace esphome
