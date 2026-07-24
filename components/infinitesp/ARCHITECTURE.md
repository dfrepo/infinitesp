# InfinitESP — Component Architecture & Data Flows

How the `components/infinitesp` ESPHome external component turns Carrier/Bryant
Infinity RS-485 (ABCD bus) traffic into Home Assistant entities, and how HA
controls flow back onto the bus.

- **Bus wire format** is documented separately in `ODU_PROTOCOL_FINDINGS.md`.
- This document covers the **software architecture**: frame handling, the register
  store, entity notification, unit conversion, and the active-emulation write path.

---

## 1. Big picture

The component runs as a single ESPHome `Component` that is also a `uart::UARTDevice`
(`InfinitESPComponent`, `infinitesp.h:320`). It operates in two overlapping roles:

1. **Passive snooper** — reads every frame on the shared RS-485 bus (thermostat ⇄
   indoor furnace ⇄ outdoor unit ⇄ zone controllers) and caches the decoded
   register payloads.
2. **Active emulator** — impersonates a **SAM** (System Access Module, addr `0x92`)
   and optionally a **Zone Controller** (addr `0x60/0x61`). It answers READ/WRITE
   requests addressed to those and *injects* WRITE frames to the thermostat to apply
   Home Assistant commands.

```
                    ┌────────────────── ESP32 (this component) ──────────────────┐
  RS-485 ABCD bus   │                                                            │
  20 tstat          │   UART RX ─► parse_byte_ ─► validate ─► dispatch_frame_     │
  40 furnace  ◄────►│                                   │                        │
  50 outdoor        │                                   ▼                        │
  60 zone ctlr      │              store_register_  +  notify_entities_          │
                    │                        │               │                  │
                    │                device_registers_        ▼                  │
                    │              (addr → reg → bytes)   InfinitESPEntity list   │
                    │                        ▲               │ on_register_update │
                    │   UART TX ◄─ transmit_ ─┘              ▼                    │
                    │        ▲          frame_        publish_state()             │
                    └────────┼───────────────────────────────┼──────────────────┘
                        control()                         ESPHome native API
                             ▲                                 │
                             └──────────── Home Assistant ◄────┘
```

---

## 2. Building blocks

### 2.1 The component (`infinitesp.cpp` / `.h`)
The frame engine, register cache, poller, and all protocol logic. Key state:

| Member | Purpose |
|--------|---------|
| `device_registers_` | `map<addr, map<reg_key, vector<uint8_t>>>` — the **register store** (source of truth for all entities) |
| `entities_` | list of `InfinitESPEntity*` to notify on updates |
| `rx_buffer_` / `current_frame_` | in-progress frame assembly / last parsed frame |
| `pending_polls_` | outstanding active-poll requests awaiting a matching REPLY |
| `sam_address_` / `zc_address_` | emulated device addresses |

`reg_key` is a 16-bit `(table << 8) | row`, e.g. wire register `00 03 04` →
`0x0304` (the leading `00` payload byte is a prefix; see `dispatch_frame_`).

### 2.2 The entity base (`InfinitESPEntity`, `infinitesp.h:300`)
Every platform entity multiply-inherits this **plus** its ESPHome base class
(`sensor::Sensor`, `text_sensor::TextSensor`, `select::Select`, `climate::Climate`,
`cover::Cover`, `binary_sensor::BinarySensor`). It defines:

- `on_register_update(addr, reg_key)` — **pure virtual**; the inbound hook.
- `on_system_mode_commanded(sys)` — optional; lets climate entities update in
  lockstep when *any* source changes system mode.
- `bus_class_` — upper nibble of the device address this entity cares about
  (`0`=any, `2`=tstat, `4`=IDU, `5`=ODU, `6`=ZC, `9`=SAM). Used to skip
  irrelevant notifications.

### 2.3 Platforms (auto-loaded)
`__init__.py` sets `AUTO_LOAD = [climate, sensor, select, text_sensor,
binary_sensor, cover]`. Each platform's `__init__.py` declares a **type table**
(e.g. `SENSOR_TYPES` in `sensor/__init__.py`) mapping a config `type:` string to
the ESPHome unit / device-class / `bus_class`, and each C++ entity switches on its
`sensor_type_` / `select_type_` string to decode the right field.

---

## 3. Inbound flow (bus → Home Assistant)

### Step 1 — Byte assembly (`loop` → `parse_byte_`, `infinitesp.cpp:116,292`)
`loop()` drains the UART every cycle, feeding bytes to `parse_byte_`, which:
- Resets the buffer if >100 ms elapsed since the last byte (stale fragment guard).
- Waits for the 8-byte header, reads the length byte (`rx_buffer_[4]`), then waits
  for `header + payload + 2-byte CRC` bytes.

**Frame layout** (`FRAME_HEADER_SIZE = 8`):
```
[dst][dst_bus][src][src_bus][len][pid=00][ext=00][func] [payload…] [crc_lo][crc_hi]
```
`func`: `0x0B` READ, `0x06` REPLY, `0x0C` WRITE, EXCEPTION.

### Step 2 — Validate (`validate_frame_`, `:349`)
CRC-16 over all but the last two bytes; mismatches are logged and dropped.

### Step 3 — Dispatch (`dispatch_frame_`, `:359`)
Parses header fields into `current_frame_`, logs the `RX# …` verbose line (the same
lines analyzed in `l1/l2/2.log`), then routes by destination and function:

| Condition | Handler | Meaning |
|-----------|---------|---------|
| REPLY addressed to our SAM | pending-poll match | correlate our active poll with its answer, measure RTT |
| REPLY from thermostat (`0x20`) | `handle_reply_` | thermostat answering our SAM reads (state, schedule, faults…) |
| REPLY to discovery addr `0x93` | `handle_discovery_reply_` | table-definition probes |
| READ/WRITE **to us** (SAM/ZC) | `handle_read_request_` / `handle_write_request_` | we must answer as the emulated device |
| everything else | `handle_passive_frame_` | snoop IDU/ODU traffic we don't own |

### Step 4 — Store + notify
Each handler decodes the register and calls two functions:
- `store_register_(addr, reg_key, data)` — write into `device_registers_`
  (`:1044`). This is a plain overwrite; the store always holds the latest bytes.
- `notify_entities_(addr, reg_key)` — fan out to entities (`:1048`).

`handle_passive_frame_` (`:458`) is the ODU/IDU path: for REPLY frames whose source
class is `4` (IDU) or `5` (ODU), it stores under the source address and notifies —
this is how blower RPM, airflow, ODU temps, voltage, etc. reach HA even though the
ESP never requested them.

### Step 5 — Entity fan-out (`notify_entities_`, `:1048`)
```cpp
uint8_t src_class = device_addr >> 4;
for (auto *entity : entities_) {
  uint8_t dc = entity->get_bus_class();
  if (dc != 0 && src_class != 0 && dc != src_class) continue;  // skip mismatched
  entity->on_register_update(device_addr, register_key);
}
```
The `bus_class` gate means an ODU sensor (`bus_class 5`) ignores IDU/thermostat
updates cheaply.

### Step 6 — Decode + publish (per-entity `on_register_update`)
Each entity checks `register_key` and its own `sensor_type_`, reads the raw bytes
back from the store via `parent_->get_register(addr, reg_key)`, applies the decode
(scaling / unit conversion), and — only if a valid value was produced — calls the
ESPHome base `publish_state()`, which pushes to Home Assistant over the native API.

Example (`sensor/infinitesp_sensor.cpp:45`):
```cpp
if (register_key == REG_IDU_STATUS && sensor_type_ == "blower_rpm") {
  auto *data = parent_->get_register(device_addr, REG_IDU_STATUS);
  if (data) { float rpm = parent_->idu_blower_rpm_(*data);
              if (!std::isnan(rpm)) value = rpm; }
}
...
if (!std::isnan(value)) publish_state(value);   // → HA
```
`NaN` is the "no update" sentinel: absent/uninstalled sensors and non-matching
registers leave `value = NAN`, so nothing is published (avoids emitting `0`).

Decoding helpers live on the component (e.g. `idu_blower_rpm_`,
`odu_compressor_frequency_`, `odu_line_voltage_`, `odu_float_`), keeping the raw
byte-offset/scaling knowledge in one place.

**Register-store fields → entity mapping** (representative):

| reg_key | Source addr class | Entities |
|---------|-------------------|----------|
| `3B02` (SAM state) | SAM (9) | zone `temperature`, `humidity`, `outdoor_temperature`, `system_mode` select |
| `3B03` (SAM zones) | SAM (9) | `fan_mode` select, hold/setpoint climate state |
| `0306`/`0316` (IDU) | IDU (4) | `blower_rpm`, `airflow_cfm`, cycle/runtime counters |
| `0302`/`0304`/`0604`/`0608`/`060E`/`061F` (ODU) | ODU (5) | ODU temps, `odu_line_voltage`, `compressor_rpm`, `compressor_frequency`, `odu_stage`, superheat floats |
| `0302` (ZC) | ZC (6) | `zc_zone_temperature`, `zc_lat`, `zc_hpt` |

---

## 4. Outbound flow (Home Assistant → bus)

HA control actions arrive on the ESPHome control virtuals of the *controllable*
platforms: `climate` (`control`, `climate/infinitesp_climate.cpp:57`), `select`
(`control`, `select/infinitesp_select.cpp:10`), and `cover` (dampers).

### Step 1 — Translate HA → bus units
`control()` maps HA semantics to bus values:
- Climate mode enum → `SYSMODE_*` (heat/cool/auto/off).
- `°C` target → whole-`°F` bus setpoint via `celsius_to_setpoint()`.
- Fan enum → `FAN_*`.
- Presets → comfort-profile activities (register `400A`) with a hold.

### Step 2 — Apply via component helpers
`control()` calls parent helpers, e.g. `set_system_mode()`, `set_zone_setpoint()`
(`:1170`), `set_zone_fan()`, `apply_activity()`, `set_zone_hold()`. These:
1. **Update the local cache first** (`mirror_to_sam_`) so reads stay consistent.
2. **Build a WRITE payload** against the thermostat's register (e.g. `3B03` zone
   block with a change-flags header).
3. **Emit** it with `send_write_frame_(ADDR_THERMOSTAT, …)`.

### Step 3 — Transmit (`send_write_frame_` → `transmit_frame_`, `:673,618`)
`transmit_frame_` builds `[header][payload][CRC]`, toggles the RS-485
`flow_control_pin_` (DE/RE) around `write_array()` + `flush()`, and logs a `TX#`
line. WRITEs are also queued in `pending_retransmits_` for one automatic
retransmit (half-duplex reliability).

### Step 4 — Optimistic + lockstep UI
- The controlling entity immediately `publish_state()`s the new value (optimistic),
  rather than waiting for the thermostat's confirming broadcast.
- `set_system_mode()` calls `on_system_mode_commanded(mode)` on **every** entity
  (`:1450`) so all zone climates flip together without waiting for the (laggy) bus
  confirmation. The next `3B02` broadcast then reconciles the cache.

---

## 5. Active polling & emulation

Beyond snooping, the component actively drives the bus when it is idle:

- **Poll cadence** (`loop`, `:194`+): when the bus has been quiet ~50 ms and every
  ~3 s, it polls the thermostat / discovers devices. Each outbound READ is tracked
  in `pending_polls_` (dest, reg_key, tx_seq, timestamp).
- **Reply matching** (`dispatch_frame_`, `:398`): an incoming REPLY to our SAM is
  correlated to the oldest matching pending poll (RTT logged); unmatched/late
  replies are logged and purged after 5 s.
- **Serving reads** (`handle_read_request_`, `:694`): when the thermostat READs a
  register from our emulated SAM/ZC, we answer from `device_registers_` (or an
  exception if unknown).
- **Serving writes** (`handle_write_request_`, `:728`): the thermostat pushing state
  to our SAM (e.g. `3B06`, damper commands) is stored and re-notified to entities.

This dual role is why a single register (e.g. `3B02`) can be populated either by our
own poll's REPLY *or* by an unsolicited thermostat broadcast — both land in the same
store and trigger the same `notify_entities_` path.

---

## 6. Units, temperature & F/C handling

The ABCD bus uses **whole °F** for setpoints and **1/16 °F** (`raw/16`) for many
sensor temperatures; Home Assistant works in **°C** internally. Conversion is
centralized on the component:

| Helper | Direction |
|--------|-----------|
| `bus_temp_to_celsius()` / `setpoint_to_celsius()` | bus °F → HA °C (read path) |
| `celsius_to_setpoint()` | HA °C → bus °F (write path) |
| `bus_celsius_detected_` + `temperature_unit` (`auto`/`F`/`C`) | runtime heuristic for buses that report °C |

Climate traits set `visual_temperature_step = 1.0` and min/max in °C so HA's UI
steps by exactly 1 °F despite the °C round-trip (see the extended comment at
`climate/infinitesp_climate.cpp:13`). ZC-fed external sensors carry an explicit
`sensor_unit: F|C` to avoid mis-conversion, with a runtime plausibility band.

---

## 7. Configuration & codegen (`__init__.py`)

- `CONFIG_SCHEMA` validates YAML options: `sam_address` (default `0x92`),
  `zone_controller_address`, `flow_control_pin`, status LED, `temperature_unit`,
  and per-zone/thermistor ZC sensor references.
- `to_code()` instantiates the component, wires optional pins/sensors, registers it
  as a `Component` + `UARTDevice`.
- `register_infinitesp_entity()` (called by each platform's `to_code`) links an
  entity to its parent via `register_entity()` + `set_parent()`, and the platform
  sets `sensor_type_`, `zone_`, and `bus_class` from its type table.

---

## 8. End-to-end examples

**Reading outdoor coil temperature (passive):**
1. Thermostat READs ODU temps → ODU REPLYs on the bus.
2. `parse_byte_` assembles the frame → `validate_frame_` (CRC) → `dispatch_frame_`.
3. Not addressed to us → `handle_passive_frame_` stores `device_registers_[0x5x][0x0302]`
   and calls `notify_entities_(0x5x, 0x0302)`.
4. `notify_entities_` skips all non-`bus_class 5` entities; the `odu_coil_temp`
   sensor's `on_register_update` decodes `int16be/16` °F → °C and `publish_state()`s.
5. ESPHome native API pushes the new value to Home Assistant.

**Lowering the cool setpoint from HA (active):**
1. HA calls climate `control()` with a new `target_temperature`.
2. `celsius_to_setpoint()` converts to whole °F; `set_zone_setpoint()` updates the
   local `3B03` cache and builds a WRITE payload.
3. `send_write_frame_(0x20, …)` → `transmit_frame_` emits it (with DE/RE toggle) and
   queues a retransmit.
4. The climate entity optimistically `publish_state()`s the new setpoint.
5. The thermostat later broadcasts an updated `3B02`/`3B03`, which flows through the
   inbound path and reconciles the cache.

---

## 9. File map

| File | Role |
|------|------|
| `infinitesp.cpp` / `.h` | frame engine, register store, poller, emulation, decode helpers |
| `__init__.py` | component config schema + codegen, `AUTO_LOAD` platforms |
| `sensor/` | numeric sensors (temps, RPM, CFM, voltage, counters) — read-only |
| `binary_sensor/` | bus-online, fault, running flags — read-only |
| `text_sensor/` | model/serial strings, mode/status text — read-only |
| `select/` | `system_mode`, per-zone `fan_mode` — read/write |
| `climate/` | per-zone thermostat entity (mode, setpoints, fan, presets) — read/write |
| `cover/` | zone damper positions — read/write |
