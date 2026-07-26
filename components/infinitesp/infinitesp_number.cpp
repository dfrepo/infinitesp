#include "infinitesp_number.h"
#include <cmath>

namespace esphome {
namespace infinitesp {

// How long to suppress stale poll data after a write (ms). Matches the climate
// entity's PENDING_SETPOINT_WINDOW_MS so both settle over the same interval.
static const uint32_t NUMBER_PENDING_WINDOW_MS = 8000;

void InfinitESPNumber::control(float value) {
  // Convert the requested °C to the bus whole-°F setpoint encoding.
  uint8_t sp = parent_->celsius_to_setpoint(value);

  // set_zone_setpoint() writes BOTH heat and cool for the zone, so read the
  // sibling setpoint from 3B03 and preserve it. Fall back to the same value if
  // the register isn't populated yet (first boot before any 3B03 frame).
  uint8_t idx = zone_ - 1;
  auto *data = parent_->get_register(parent_->get_sam_address(), REG_SAM_ZONES);
  uint8_t heat = sp;
  uint8_t cool = sp;
  if (data && data->size() >= REG3B03_COOL_SETPOINTS + 8) {
    heat = data->at(REG3B03_HEAT_SETPOINTS + idx);
    cool = data->at(REG3B03_COOL_SETPOINTS + idx);
  }
  if (number_type_ == "heat_target")
    heat = sp;
  else  // cool_target
    cool = sp;

  parent_->set_zone_setpoint(zone_, heat, cool);
  pending_until_ms_ = millis() + NUMBER_PENDING_WINDOW_MS;

  // Echo the rounded °F back as °C so the UI shows the value that was actually
  // committed to the bus, not the raw slider value.
  float committed = parent_->setpoint_to_celsius(sp);
  last_value_ = committed;
  publish_state(committed);
}

void InfinitESPNumber::on_register_update(uint8_t device_addr, uint16_t register_key) {
  if (register_key != REG_SAM_ZONES)
    return;
  // Hold the just-written value while the thermostat confirms; a stale 3B03
  // poll in this window would otherwise snap the display back.
  if (pending_until_ms_ != 0 && millis() < pending_until_ms_)
    return;
  pending_until_ms_ = 0;

  auto *data = parent_->get_register(parent_->get_sam_address(), REG_SAM_ZONES);
  if (!data || data->size() < REG3B03_COOL_SETPOINTS + 8)
    return;
  uint8_t idx = zone_ - 1;
  if (!(data->at(REG3B03_ACTIVE_ZONES) & (1 << idx)))
    return;

  uint8_t raw = (number_type_ == "heat_target") ? data->at(REG3B03_HEAT_SETPOINTS + idx)
                                                : data->at(REG3B03_COOL_SETPOINTS + idx);
  float c = parent_->setpoint_to_celsius(raw);
  // Force first publish (last_value_ is NaN) so the entity populates on boot.
  if (std::isnan(last_value_) || std::abs(c - last_value_) > 0.01f) {
    last_value_ = c;
    publish_state(c);
  }
}

}  // namespace infinitesp
}  // namespace esphome
