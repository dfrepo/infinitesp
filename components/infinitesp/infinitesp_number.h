#pragma once
#include "esphome/components/number/number.h"
#include "infinitesp.h"

namespace esphome {
namespace infinitesp {

// Per-zone heat/cool setpoint as a read-write, history-graphable number.
// Reads the zone's setpoint from SAM register 3B03 and writes changes back via
// set_zone_setpoint(). Complements the climate entity: a first-class numeric
// state (unlike the climate's target_temperature_* attributes) so Home
// Assistant records clean history/statistics graphs.
class InfinitESPNumber : public number::Number, public InfinitESPEntity {
 public:
  void control(float value) override;
  void on_register_update(uint8_t device_addr, uint16_t register_key) override;
  void set_number_type(const std::string &type) { number_type_ = type; }

 protected:
  std::string number_type_;
  float last_value_{NAN};
  // Suppress stale poll data for a window after a write, so a lagging 3B03
  // frame doesn't snap the displayed value back before the thermostat confirms
  // (mirrors the climate entity's pending-setpoint overlay).
  uint32_t pending_until_ms_{0};
};

}  // namespace infinitesp
}  // namespace esphome
