# SHOOT // BODYCAM v0.8: LOCKED & LOADED (3D Tactical FPS Engine)

An ultra-immersive, mobile-first 3D Tactical First-Person Shooter built in TypeScript, Three.js (WebGL2), Custom GLSL Post-Processing Shaders, and a Real-Time Procedural WebAudio Acoustic Pressure-Wave Synthesizer—modeled directly after **Reissad Studio's *Bodycam* (including the September 2, 2026 v0.8 *Locked & Loaded* overhaul)**.

---

## 1. Research Dossier: *Bodycam* by Reissad Studio

* **Developer & Engine**: Created by French indie studio **Reissad Studio** (founded by Luca and Léo) in **Unreal Engine 5**. Released in Early Access on June 7, 2024, with its largest overhaul **v0.8 "Locked & Loaded"** launching on September 2, 2026.
* **True Body & Unlinked Free-Aim Deadzone**: Unlike traditional FPS games where weapons are rigidly locked to the screen center, *Bodycam* mounts a wide-angle fisheye camera to the operator's chest (*True Body*). Moving your aim pivots your arms and weapon inside a physical free-aim deadzone with spring-damper inertia before turning the torso, and bullets fire along the **actual 3D barrel vector**.
* **v0.8 Stress-Driven Dynamic Reloads**: Introduced in *Locked & Loaded*, a real-time **Stress float parameter** (driven by nearby gunfire suppression, explosions, and combat intensity) dynamically alters weapon reloads. When calm, reloads are crisp and retain `+1` round in the chamber; when stressed (`>48%`), the operator's hands tremble, magazines fumble against the magwell with metallic rattle, and reloads take longer.
* **Diegetic No-HUD Realism & Mag Checks**: There is no traditional crosshair or digital ammo counter. Players rely on physical iron sights/optics, visible 3D laser beams, weapon flashlights (`[F]`), and pulling the magazine out slightly (`[M]` Mag Check) to inspect remaining brass cartridges.
* **Authentic v0.8 Weapon Roster & 8-Effect Attachment System**:
  * **Assault Rifles**: `KA-74` (Free), `M4` (3,000 RP, 667 RPM), `SKR-H` (7,000 RP, 600 RPM, 450+ DPS), `KA-74M` (3,000 RP), `M16-1A` (4,000 RP, 20 rnds), `Drako` (2,700 RP).
  * **SMGs / Machine Pistols**: `Veaper` (8,000 RP, 1,200 RPM Vector shredder), `SG9-X` (5,000 RP, 857 RPM), `SG5-K` (5,000 RP, 800 RPM), `UZ-1` (Free, 750 RPM).
  * **Shotguns**: `BK-102S` (Free, 75 RPM 12G Pump), `BK-101` (3,000 RP Breacher), `Vaiga` (7,000 RP, 240 RPM Saiga-12), `R12` (5,000 RP, 333 RPM).
  * **Snipers / Marksman**: `Rivington 700` (4,000 RP, 43 RPM Bolt-Action—110 DMG one-shot chest kill), `VSD` (15,000 RP Dragunov), `LAR` (8,000 RP FAL).
  * **Pistols & Revolvers**: `Mlock19` (Free, 17 rnds), `Deagle` (10,000 RP, 100 DMG), `CR-75` (3,500 RP), `M1914` (4,000 RP), `Revolver` (6,000 RP, 8-shot .357).
  * **8 Official Attachment Modifiers**: Every attachment modifies up to 8 parameters defined by Reissad Studio: **ADS Speed, Switch Speed, Reload Speed, Horizontal Recoil, Vertical Recoil, Spread, Kick, and Ammo Capacity**.
* **In-World Tactical Tablet, FPV Drones & RC Cars**: Menus are housed inside an in-world **Tactical Tablet** (`[TAB]`). Operators can deploy **FPV Reconnaissance/Strike Drones** (featuring both **Casual Stabilized** and **Acro Manual FPV Physics** modes) and **Explosive RC Cars** while their operator body stands in the world.
* **Law-Enforcement Face Redaction & Ragdoll Stumbling**: Operator faces feature a pixelated mosaic censorship blur, and non-lethal hits cause physical **Ragdoll Stumbling** before lethal collapse.

---

## 2. Primary Target: Mobile-First Touch & Desktop Controls

| Action | Mobile Touch Controls | Desktop Keyboard / Mouse |
| :--- | :--- | :--- |
| **Move / Sprint** | Left Virtual Thumbstick (Push upper rim to Sprint) | `W A S D` + `Left Shift` |
| **Free-Aim & Turn** | Right-Half Touch Look Pad (or Drag while holding `🔥 FIRE`) | Mouse Move (PointerLock or Click-Drag) |
| **Fire Weapon** | Right `🔥 FIRE` Button OR Left-Hand Claw `L-FIRE` Button | `Left Mouse Button` |
| **Aim Down Sights (ADS)** | `🎯 ADS` Touch Button | `Right Mouse Button` |
| **Reload (Calm / Stressed)** | `🔄 RELOAD` Touch Button | `R` |
| **Diegetic Mag Check** | `🔍 MAG` Touch Button | `M` |
| **Corner Lean Left / Right** | `LEAN L` / `LEAN R` Touch Buttons | `Q` / `E` |
| **Crouch** | `🧎 CROUCH` Touch Button | `C` |
| **Swap Primary / Pistol** | `🔀 SWAP` Touch Button | `1` / `2` |
| **Fire Mode Selector** | Weapon Status Tap | `B` (Auto / Semi / Burst) |
| **Flashlight / Night Vision** | `🔦 LIGHT` / Top `🟢 NVG` Button | `F` (Flashlight) / `N` (NVG) |
| **Throw M67 Frag / M84 Stun** | `💣 THROW` Touch Button | `G` |
| **FPV Drone / RC Car** | `🚁 GADGET` Touch Button | `V` (`Space` to Detonate C4) |
| **v0.8 Tactical Tablet** | Top `📱 TABLET / LOADOUT` Button | `TAB` or `ESC` |

---

## 3. Running & Building Locally

```bash
npm install
npm run dev      # Starts live server on 0.0.0.0:5173
npm run build    # Runs strict TypeScript check + builds production bundle into dist/
```
