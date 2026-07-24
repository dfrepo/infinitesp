# InfinitESP — Register Findings (Outdoor Unit + Furnace)

Reverse-engineering notes for the Carrier/Bryant Infinity half-duplex RS-485 bus.
Primary focus is the conversation between **`20` = thermostat (SAM)** and
**`50` = outdoor unit (ODU, "EVEREST TWO CAPACITY ODU")**; §3 covers the
**`40` = indoor furnace / ECM blower** (airflow, blower RPM, static pressure).

Derived from captures `2.log`, `l1.log`, `l2.log`. Values below are **best-effort
interpretations**; confidence is noted per field.

---

## 1. Log line / frame format

A raw intercept line looks like:

```
[16:31:00.112][V][InfinitESP:386]: RX#1063 20[1]->50[1] READ len=3 plen=3 [00 03 11 ],
```

| Token           | Meaning                                                            |
|-----------------|-------------------------------------------------------------------|
| `[16:31:00.112]`| Host timestamp `HH:MM:SS.mmm`                                      |
| `RX#1063`       | Monotonic frame counter                                           |
| `20[1]`         | Source address `[bus?]` — here `20` = thermostat                  |
| `->50[1]`       | Destination address — here `50` = outdoor unit                    |
| `READ`          | Function / command (see below)                                    |
| `len` / `plen`  | Frame length / payload length (bytes)                             |
| `[00 03 11 ]`   | Payload bytes (hex)                                               |

### Commands (functions)

| Command | Direction (typical) | Payload layout                                         |
|---------|---------------------|--------------------------------------------------------|
| `READ`  | `20 -> 50`          | `[reg0 reg1 reg2]` — 3-byte **register id**, no data    |
| `WRITE` | `20 -> 50`          | `[reg0 reg1 reg2] [value...]` — register + new value    |
| `REPLY` | `50 -> 20`          | `[reg0 reg1 reg2] [value...]` — echoes register + data  |

**Request/response pairing:** every `20->50 READ/WRITE` is answered by the next
`50->20 REPLY` whose first 3 payload bytes match the requested register.
A `WRITE` is acknowledged by a short `REPLY` (often a single `00`).

### Register numbering

The 3-byte wire register maps to the firmware's 16-bit register keys as
`[prefix=00] [regHi] [regLo]`, e.g. wire `00 03 04` = firmware key `0x0304`.
Firmware groups registers into **tables**: `0x03xx` = "RLCSMAIN" main controller
sensors/status, `0x06xx` = "VAR COMP" variable-speed compressor drive. (The
thermostat-polled `00 3E xx` temperature register observed here is not in the
firmware's snooped table list but follows the same conventions.)

### Multi-byte value convention

Unless noted, multi-byte scalar values are **big-endian (MSB first)**.

- 16-bit temperature = `raw / 16` in **°F** (Carrier Infinity 1/16 °F encoding).
  Corroborated by firmware for `0x0302` (int16be/16, native °F).
- `0x03FF` (1023) in a temperature slot = **sensor absent / not connected** sentinel.
- Compressor drive frequency (variable-speed units only) = `raw / 10` **Hz** in
  register `0608`; **not present on this 2-capacity ODU**.
- Fixed-point pressure (static pressure): `raw / 65536` = inches w.c. (Q16) — see §4.

---

## 2. Register map (register = first 3 payload bytes)

Notation: `REG = [b0 b1 b2]`, then REPLY data bytes are indexed `d0 d1 d2 ...`
(i.e. reply payload = `[b0 b1 b2 d0 d1 d2 ...]`).

Confidence: **[H]** high (validated against UI), **[M]** medium, **[L]** low/guess.

---

### `00 01 04` — ODU model string  **[H]**
```
REPLY: [00 01 04] d0..d122
```
- `d0..` = ASCII, null-padded. Decodes to `"EVEREST TWO CAPACITY ODU"`.
- Static identity string.

---

### `00 3E 01` — ODU temperatures (live)  **[H]**
```
REPLY: [00 3E 01] d0 d1 | d2 d3 | d4 d5 | d6 d7 | d8 d9 da db dc
                   ^word0   ^word1  ^abs    ^abs    ^config (const)
```
| Bytes    | Field                | Scaling / value                              | Conf |
|----------|----------------------|----------------------------------------------|------|
| `d0 d1`  | Outdoor **ambient** temp | `u16be / 16` → °F (e.g. `04 A3` = 1187/16 = 74.2 °F) | H |
| `d2 d3`  | Outdoor **coil** temp    | `u16be / 16` → °F (e.g. `05 0A` = 1290/16 = 80.6 °F) | H |
| `d4 d5`  | Temp sensor 3 (absent)   | `03 FF` = 1023 sentinel → not present         | M |
| `d6 d7`  | Temp sensor 4 (absent)   | `03 FF` = 1023 sentinel → not present         | M |
| `d8..dc` | Config trailer           | Constant `00 00 01 01 3C`                     | M |

Validation: at rest coil ≈ ambient (~73–74 °F); during cooling the coil rises to
~80 °F while ambient drifts only with time-of-day. Matches reported UI exactly.

---

### `00 3E 02` — Compressor stage  (`HeatPump02`, per Infinitude wiki)  **[H]**
```
REPLY: [00 3E 02] d0
```
- **Stage = `d0 >> 1`** (wiki: "shift right by 1 to get the stage number").
- Observed: `d0 = 0x01` → stage 0 (**idle**); `d0 = 0x02` → stage 1 (**running**,
  low capacity). A 2-capacity unit would show `0x04` → stage 2 (not seen here).

Flips exactly in sync with blower/airflow starting and with `0304` field `0143`.

---

### `00 3E 03` — Flag (const)  **[L]**  `d0 = 0x01`
### `00 3E 04` — Flag (const)  **[L]**  `d0 = 0x00`

---

### `00 05 02` — Compressor status word  **[M]**
```
REPLY: [00 05 02] d0 d1 d2 d3 d4
```
| Bytes    | Field                          | Notes                                     |
|----------|--------------------------------|-------------------------------------------|
| `d0`     | Status/state byte              | `0xD0` idle → `0xD2` / `0x92` when running | 
| `d1..d4` | (unknown, mostly `01 1D 00 00`)| minor variation                            |

`d0` reliably changes with compressor state; exact bit meanings TBD.

---

### `00 05 04` — Config limits (const)  **[M]**
```
REPLY: [00 05 04] d0..d7  = 03 20 03 E8 02 D0 03 D4
```
- Four u16be constants: `800, 1000, 720, 980` — appear to be fixed limits/setpoints.

---

### `00 03 04` — ODU electrical / operating status block (tagged)  **[H/M]**

Firmware key `0x0304` = `REG_ODU_STATUS3` ("Temperatures and pressures").

**Tagged block format:** after the 3 register bytes, the payload is a sequence of
**4-byte records**: `[tagHi tagLo valHi valLo]` (value = `u16be`).

```
REPLY: [00 03 04] (01 18 vv vv)(01 17 vv vv)(01 41 vv vv)(01 42 vv vv)(01 43 vv vv)(00 44 vv vv)
```

| Tag     | Field                         | Scaling / typical value                      | Conf |
|---------|-------------------------------|----------------------------------------------|------|
| `01 18` | (unknown, const)              | `60`                                          | L |
| `01 17` | **Line voltage**              | **`u16be` at `data[6..7]`**, volts (e.g. `00 F2`=242, `01 08`=264). Reading only `data[7]` wraps above 255 V. | H |
| `01 41` | Inverter rail / bus (measured)| ~2604 idle → sags to ~2467 running; scale TBD | M |
| `01 42` | (unused)                      | `0`                                           | L |
| `01 43` | Compressor-active / demand (unresolved) | 0 = off; ~378–386 when running (low stage) | L |
| `00 44` | (unused)                      | `0`                                           | L |

Notes on `01 43` (compressor-active / demand indicator):
- **Command-like:** steps instantly `0 -> ~383` at start (no ramp), holds a tight
  band the whole run, returns to `0` at shutoff.
- Independent of indoor airflow (same ~383 at 604 CFM and 863 CFM).
- **NOT a compressor drive frequency.** An earlier pass read it as `raw/10 = 38.3 Hz`
  by analogy to the variable-speed register `0608`. That is almost certainly wrong here:
  this is a **2-capacity** (2-stage) ODU with **no inverter/VFD**, so there is no variable
  drive frequency to report, and `38.3 Hz → 30×f ≈ 1149 RPM` is not a real scroll speed.
  The fact that it stays flat across both airflow levels also argues against a
  speed/capacity signal. True unit unknown — treat as an opaque "compressor demand" code
  until a capture with varying stages resolves it. For capacity on this unit, use the
  discrete stage from `3E02` (`d0 >> 1`).

Notes on `01 41`: unlike `0143` this value varies continuously under load (a real
measured quantity), likely a DC bus / saturation reference. Scale not yet resolved.

---

### `00 03 11` — ODU runtime hours (`REG_ODU_RUNTIME`, 0x0311)  **[H]**
Decoded with the firmware **KV codec** (4-byte records `[key,b1,b2,b3]`,
value = 24-bit BE). See §10 for the cross-validation.
```
REPLY: [00 03 11] (25 ..)(26 ..)(2A 00 2D 13)(29 00 0A 7E)(3D ..)(2C ..)
```
| Key  | Field           | Value (2.log → l1 → l2)         |
|------|-----------------|---------------------------------|
| `25` | heat hours      | 0                               |
| `2A` | **cool hours**  | 11537 → 11539 → 11539 (rising)  |
| `3D` | defrost hours   | 0                               |
| `2C` | power-on hours  | 164138 → 164157 (rising)        |

Resolves the earlier "`2D 13`→`2D 14` slow counter" — it is the low bytes of the
cool-hours accumulator (key `0x2A`), incrementing as the ODU runs.

---

### `00 03 0D` — Unused  **[H]**  → all zero `00 00 00 00 00 00 00`

---

### `00 3E 0C` — ODU cool-cycle counter (compact)  **[M]**
```
REPLY: [00 3E 0C] 00 AC <cyc> 00 00 00 00 10 B4 00 00 00 00 00 00
```
- Byte `d2` = cumulative counter: `17` (2.log) → `32` → `32` (monotonic across
  captures, +1 per cooling cycle) — parallels the `0310` cool-cycles key.

### `00 3E 0D` — Block (static)  **[L]**
```
REPLY: [00 3E 0D] 00 2D 00 1D 00 2E 00 09 00 03 00 02 01 17
```

### `00 3E 0E` — Compact echo of `0311` runtime counters  **[H]**
```
REPLY: [00 3E 0E] <cool_h u16> 00 00 <0x29 u16> 00 00 00 00
```
- `u16[0..1]` = **cool hours** = `11537 / 11539` — matches `0311` key `0x2A` exactly.
- `u16[4..5]` = `2686` — matches `0311` key `0x29` exactly.
  (Earlier "coil-ish" guess was wrong; it mirrors the runtime counters.)

---

### WRITE registers (thermostat → ODU)  **[L]**
Observed writes, each ACKed by a short `50->20 REPLY [00]`:

| Register  | Example payload            | Meaning       |
|-----------|----------------------------|---------------|
| `00 3E 0A`| `00 22 B8`                 | setpoint/cmd  |
| `00 3E 02`| `02`                       | mode command  |
| `00 3E 03`| `01`                       | command       |
| `00 05 0F`| `00 00 00 00`              | command       |
| `00 05 10`| `00 00 00 00`              | command       |

---

## 3. Indoor unit / furnace (addr `40`) — non-ODU findings

The thermostat (`20`) also polls the variable-speed furnace at address `40`
(firmware table `0x03` "RLCSMAIN", ECM blower drive). These carry the **airflow,
blower and (derived) static-pressure** quantities — they are **not** present in the
outdoor-unit (`50`) stream.

### `00 03 06` — IDU blower status  (`REG_IDU_STATUS`)  **[H]**
```
REPLY: [00 03 06] d0 d1 d2 d3 d4 d5 d6 d7 d8 d9
```
| Bytes   | Field             | Scaling / value                                   | Conf |
|---------|-------------------|---------------------------------------------------|------|
| `d1 d2` | **Blower RPM**    | `u16be`, direct (e.g. `02 F9` = 761 RPM)          | H |
| `d3 d4` | **Airflow CFM**   | `u16be`, direct (e.g. `03 5F` = 863 CFM)          | H |
| `d6 d7` | limit const       | `07 D0` = 2000 (max CFM/RPM limit)                | L |
| `d9`    | run flag          | `00` idle / `08` running                          | M |

Observed: rest `RPM=0, CFM=0`; dehumidify `RPM≈582, CFM=604`; stage 1 `RPM≈823, CFM=863`.

### `00 03 16` — IDU config / airflow / static  (`REG_IDU_CONFIG`, "AirHandler16")  **[H]**
```
REPLY: [00 03 16] d0 d1 d2 d3 d4 d5 d6 d7 d8 d9 da db dc dd
```
Layout per Infinitude wiki: `state, unknown[3], airflow_cfm(u16), unknown, static_pressure(u16), …`

| Bytes   | Field             | Scaling / value                                   | Conf |
|---------|-------------------|---------------------------------------------------|------|
| `d0`    | heat state (wiki) | `00`=no_heat `01`=low `02`=med `03`=high; **always `00` in our cooling capture** | L |
| `d2`    | status byte       | `00` idle → `02` running (our observation)        | M |
| `d4 d5` | **Airflow CFM**   | `u16be`, direct (e.g. `03 5F` = 863 CFM)          | H |
| `d7 d8` | static pressure?  | wiki: `u16be / 65536` w.c. — **not confirmed here** (see below) | L |
| `dc dd` | limit const       | `02 BC` = 700                                     | L |

### Static pressure (duct)  **[L — documented in wiki, NOT confirmed in our capture]**

Reported UI values: `0` (blower off) → `~0.28"` (604 CFM) → `~0.55"` (863 CFM) w.c.

- **Wiki says** it lives in register `0316` as `static_pressure / 65536` (Q16), at roughly
  bytes `d7 d8` (after airflow `d4 d5` + a spacer).
- **Our logs do NOT confirm this.** No byte offset reproduces the UI `0.28 → 0.55`:

  | Airflow | UI static | `d7d8`/65536 | `d8d9`/65536 |
  |---------|-----------|--------------|--------------|
  | 604 CFM | 0.28"     | 0.087        | 0.267        |
  | 863 CFM | 0.55"     | 0.266        | 0.119        |

  `d7d8` is too low at both points and jitters `0.266–0.317` at constant 863 CFM;
  the neighbor `d8d9` moves the *wrong direction*. An earlier exhaustive Q16 scan
  (every offset/width/endianness) likewise found no clean `0.28→0.55` field.
- **Status:** unresolved on this airhandler. Either it does not populate the wiki's
  static field, uses a different scale/offset, or the UI values were not concurrent
  with the sampled frames. Needs a capture with the UI static reading logged at the
  same instant as the `0316` frame before claiming a decode.

---

## 4. Firmware-defined ODU registers NOT seen in these captures

For reference (from `components/infinitesp/infinitesp.h`), the outdoor unit also
exposes a "VAR COMP" table (`0x06xx`) read by the SAM, absent from `l1/l2/2.log`:

| Reg      | Firmware meaning                                                        |
|----------|------------------------------------------------------------------------|
| `0x0302` | ODU temps int16be/16 °F: outdoor, coil, suction, superheat(Δ), amb, discharge |
| `0x0604` | Compressor speed: target RPM `[0..1]`, current RPM `[2..3]`             |
| `0x0608` | Compressor drive: **frequency u16 `[5..6]` in 0.1 Hz**, EEV % `[2]`     |
| `0x0605` | Commanded compressor stage (float32 `[0..3]`: 0.0 / 1.0..5.0)          |
| `0x060E` | Actual stage index (byte 0: 0=off, 1..5)                               |
| `0x061F` | Float32 block: superheat/subcooling targets & actuals (ΔT, °F)         |

These describe the **variable-speed** heat pump; none are polled on this 2-capacity ODU.
(The earlier idea that `0608`'s 0.1-Hz scaling explains `0304`'s `0143` is **retracted** —
a 2-capacity unit has no VFD; see §2.)

---

## 5. Rest vs. active "fingerprint"

The reliable idle vs. running indicators (validated in `l1` idle, `l2` cycle):

| Indicator                 | Idle        | Running (cooling/dehumidify) |
|---------------------------|-------------|------------------------------|
| `3E 02` d0                | `01`        | `02`                         |
| `3E 01` coil vs ambient   | coil ≈ amb  | coil > ambient (rises to ~80 °F) |
| `05 02` d0                | `0xD0`      | `0x92` / `0xD2`              |
| `03 04` `0143` (demand)   | `0`         | ~378–386                     |

> **Note on `2.log`:** although originally assumed "at rest", by this fingerprint
> (`3E02=02`, coil 78.6 °F > ambient 76.1 °F, `0502`=`92/D2`, `0143`=375) the ODU
> was actually **running / cooling** during that capture.

---

## 6. Confirmed scaling summary

| Quantity            | Source                    | Formula                    |
|---------------------|---------------------------|----------------------------|
| Temperature (°F)    | `00 3E 01` d0d1, d2d3     | `u16be / 16`               |
| Absent temp sensor  | any temp slot             | `== 0x03FF` (1023)         |
| Line voltage (V)    | `00 03 04` tag `01 17`    | `u16be` (direct)           |
| Compressor demand (opaque) | `00 03 04` tag `01 43` | raw `u16be`; 0=off / ~383=running; **unit unresolved (NOT a VFD Hz)** |
| Compressor stage    | `00 3E 02` d0             | `d0 >> 1` (0=off, 1=low, 2=high) |
| Blower RPM          | `00 03 06` d1d2 (addr 40) | `u16be` (direct)           |
| Airflow (CFM)       | `00 03 06` d3d4 / `00 03 16` d4d5 (addr 40) | `u16be` (direct) |
| Static pressure (in w.c.) | `00 03 16` d7d8? (addr 40) | wiki: `u16be / 65536` (Q16) — **unconfirmed in our capture** |

---

## 7. Open items / next captures

- **Resolve `0143`** — opaque compressor-demand code (0=off / ~383=running). It is
  **not** a drive frequency (no VFD on a 2-capacity unit). Needs a capture spanning
  both stages (low→high) to learn what, if anything, it encodes.
- Resolve `0141` scale (inverter DC bus / saturation reference).
- Decode `0502`/`0504` `d1..d4` (table `0x05` TWOCACTY).
- **Re-calibrate static pressure** (`0316` d7d8 `/65536`): log a UI reading concurrent
  with the frame to reconcile the ~0.17/0.32 computed vs ~0.28/0.55 UI values.

---

## 8. Cross-validation against the firmware decoders

The shipping firmware (`components/infinitesp/infinitesp.h:549-666`) keeps a
"single source of truth" set of pure decoders. Applying those **exact encoding
patterns** to the registers we reverse-engineered from `l1/l2/2.log` confirms (and
in several cases upgrades) the findings.

### 8.1 The firmware codec toolbox

| Codec (firmware) | Rule | Used for |
|------------------|------|----------|
| `decode_int16_f_(off)` | `int16be / 16` → °F | ODU temps (`0302` at `2+idx*4`) |
| `decode_f32_be_(off)` | IEEE-754 float32 BE | superheat/subcooling `061F`, commanded stage `0605` |
| u16 BE (raw) | `(hi<<8)|lo` | blower RPM `0306[1..2]`, airflow CFM `0316[4..5]`, comp RPM `0604[0..1]/[2..3]` |
| u16 BE `/10` | → Hz (0.1 Hz) | compressor drive freq `0608[5..6]` |
| single byte | direct | voltage `0304[7]`, mode `0304[10]`, EEV% `0608[2]`, stage `060E[0]`, setpoint°F `060B[2]` |
| byte & mask | flag bits | electric heat `0316[0]&0x03` |
| **KV records** | 4-byte `[key,b1,b2,b3]`, val = 24-bit BE | cycles `0310`, **runtime hours `0311`** |
| **TLV records** | 4-byte `[tag,id,hi,lo]`, val = `u16be/16` °F | ZC zone temps `0302`; tag `0x01`=present, `0x04`=absent |

KV keys — cycles (`0310`): `23`=heat `28`=cool `3C`=defrost `2B`=poweron;
hours (`0311`): `25`=heat `2A`=cool `3D`=defrost `2C`=poweron.

### 8.2 Applying the toolbox to our "unknown" registers

**`00 03 11` = `REG_ODU_RUNTIME` (0x0311) — KV codec. [L→H]**
Decoding our payload with the firmware's 4-byte KV rule yields clean, physical,
**monotonically increasing** counters — the hallmark of runtime accumulators:

| Key | Field | 2.log | l1 | l2 |
|-----|-------|-------|----|----|
| `2A` | cool hours | 11537 | 11539 | 11539 |
| `2C` | power-on hours | 164138 | 164157 | 164157 |
| `25`/`3D` | heat/defrost hours | 0 | 0 | 0 |

Power-on `+19` and cool `+2` between `2.log` and `l1` is consistent with the
captures being ~a day apart (cooling season, no heat/defrost). This **resolves the
mysterious `2D 13`→`2D 14` "slow counter"** as the low bytes of the cool-hours field.

**`00 3E 0E` = compact echo of `0311`. [L→H]**
`u16[0..1]` = `11537/11539` = the `0311` cool-hours (`0x2A`) exactly; `u16[4..5]`
= `2686` = the `0311` key-`0x29` counter exactly. Same numbers in two independent
registers ⇒ the interpretation is self-consistent (and the earlier "coil-ish"
guess is corrected).

**`00 3E 0C` = cool-cycle counter. [L→M]**
Byte `d2` = `17 → 32 → 32`, monotonic, +1 per cooling cycle — the cycle-counter
analogue of `0310` (which the thermostat doesn't poll in these captures).

**`00 3E 01` = ODU temps via `decode_int16_f_`. [H]**
The firmware's `int16be/16 = °F` codec applied to our register gives
`off0 = 74.1 °F` (ambient), `off2 = 73.2 °F` (coil), and `off4=off6=0x03FF` →
`1023/16 = 63.9 °F` — an impossible constant, i.e. the **absent-sensor sentinel**
(mirroring the firmware's not-installed convention). Identical codec and
outdoor-then-coil field order as firmware `0302`; only the stride differs (2-byte
packed here vs `0302`'s 4-byte `2+idx*4`).

**`00 03 04` = `REG_ODU_STATUS3` (0x0304). [H voltage / L demand]**
Line voltage is the tag-`0117` value = **`u16be` at `data[6..7]`** (`00 F2`=242 V,
`01 08`=264 V). The firmware originally read only `data[7]`, which is correct until
the voltage reaches 256 V — then the low byte wraps (264→8); fixed to read the full
16-bit value. The firmware's `operating_mode = data[10]` is the MSB of our tag-`0141`
field (`0x0A` idle → `0x09` running). Tag-`0143` (0=off / ~383=running) was **wrongly**
read as `raw/10 = 38.3 Hz` by analogy to `0608`; that is retracted — this 2-capacity
ODU has no VFD, so `0143` is an unresolved demand code, not a frequency.

**`00 05 02` = status word. [L]**
`byte0` = flags (`D0`/`D2`/`92`), `u16[1..2]` = `28` idle → `285` running. No
firmware analogue; the ~10× jump on start suggests a current/load metric — unresolved.

### 8.3 Confidence changes from cross-validation

| Register | Before | After | Because |
|----------|--------|-------|---------|
| `00 03 11` | L | **H** | firmware KV codec → clean rising cool/power-on hours |
| `00 3E 0E` | L | **H** | numeric match to `0311` counters |
| `00 3E 0C` | L | **M** | monotonic cool-cycle counter |
| `00 3E 01` | H | **H** | firmware `int16/16 °F` codec + `03FF` sentinel confirmed |
| `00 03 04` `0143` | M | **L** | retracted "38 Hz" reading — no VFD on a 2-capacity ODU |

