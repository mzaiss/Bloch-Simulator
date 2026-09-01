# Bloch Simulator
Bloch simulator for NMR and MRI education.

## Extended Features
1. Adjusted original Hanson version for GitHub Pages hosting: https://mzaiss.github.io/Bloch-Simulator/

2. Added new Mixed Matter(2) for simpler IR explanation, matching an educational Jupyter Notebook https://colab.research.google.com/drive/1TJN8GDrTkvTlweFGjkLvl_pGwu-2J9vm

### Changes Made

- Replaced ES6 module imports with script tags for browser compatibility
- Downgraded THREE.js from v0.132.2 to v0.124.0 to maintain THREE.Geometry support
- Fixed OrbitControls reference and added dependency error checking
- Added a new Mixed matter with just two compartments

### Dependencies

- THREE.js v0.124.0, OrbitControls v0.124.0, dat.gui v0.7.7
- jQuery v3.5.1, jQuery UI v1.12.1

### Usage

GitHub Pages: Fork repository, enable Pages in settings, see https://mzaiss.github.io/Bloch-Simulator/ 
Local: serve the folder over HTTP (needed for example `.seq` files and ChartGPU), e.g. `python3 -m http.server`, then open the page. Opening `index.html` as a file still works for the 3D sim; use **Load .seq** to pick a sequence without a server.

### Pulseq

Load a Pulseq `.seq` file (or pick an example). The sequence is shown as a ChartGPU `seq.plot` (same stacked RF / GX / GY / GZ / ADC view as [anyfield](https://github.com/mrx-org/anyfield/blob/main/pypulseq/seq_plot.js)). **Play** runs the waveforms on the Bloch simulator. Time is stretched so a short sequence is watchable; use the speed slider to go faster or slower.

Defaults: B0 rotating frame, B1 view (not torque/B1eff), and a circular lab floor so the rotating frame does not show a spinning rectangle. Play never changes the scene, so a sequence can be watched in any of them. Gradients act through position, so choose a scene with spatial extent — **Plane**, **Weak/Strong gradient** or **Structure** — to see Gx/Gy dephase the sample; single-isochromat scenes such as Equilibrium show the RF only.

**repeat** restarts the sequence from equilibrium each time it ends.

Plot rows follow the 3D view's colours: RF magnitude in **yellow** (like the B1 arrow), RF phase **orange**, GX **blue**, GY **green**, GZ **violet**, ADC **red**. GX and GY are played as independent channels, so oblique gradients (both on at once, as in the FLASH prewinder or the EPI blips) dephase along a diagonal. GZ is plotted but does not act on the sample, which lies in the xy plane.

Playback **integrates** the waveforms over each animation frame rather than sampling them once, and splits the frame into several Bloch steps while RF is on. Flip angles and gradient moments therefore come out the same at any frame rate and at any playback speed. The speed slider is logarithmic and spans 0.002× to 5×; the slow end is what makes an individual gradient lobe readable, since a strong gradient can wind more than half a turn per frame at 5×.

Sequences are rasterized at half the finest raster the file declares — 0.5 µs for a typical 1 µs RF raster — so gradient corners and RF samples land on the grid. Very long sequences fall back to a coarser step to stay within a 300k-sample budget. Gradients defined with a Pulseq **time shape** (extended trapezoids and other non-uniform shapes, `time_id` from file version 1.4) are read at their own sample times rather than assumed to sit on the gradient raster.

Example sequences (from [MRTwin_pulseq BlochSimWeb](https://github.com/mzaiss/MRTwin_pulseq/tree/mr0-core/BlochSimWeb)):

- `seq/web1_FID.seq` — block-pulse FID, flip angles 30°…360°
- `seq/web2_SpinEcho_me.seq` — 90° then a train of 180°s
- `seq/web2_SpinEcho_sinc.seq` — sinc-pulse spin echo
- `seq/web3_FLASH_16.seq` — 16-line FLASH
- `seq/web4_RARE_16.seq` — 16-echo RARE
- `seq/web5_EPI_16.seq` — 16-line EPI

Parser tests: `node tests/pulseq.test.js`

### Mixed Matter Presets

Mixed matter (3) (3 compartments):
- Blue: T1=3.1s, T2=2.5s, generic tissue (dR1=0.2, dR2=0.2)
- Green: T1=8.0s, T2=5.0s, no additional relaxation (dR1=0, dR2=0)
- White: T1=8.0s, T2=2.5s, T2-only relaxation (dR1=0, dR2=0.2)

Mixed matter (2) (2 compartments):
- White: T1=3.1s, T2=2.5s, tissue with relaxation (dR1=0.2, dR2=0.2)
- Green: T1=8.0s, T2=5.0s, no additional relaxation (dR1=0, dR2=0)

### Quick Developer Guide: Adding New Tissue Types

To properly add new tissue presets:

1. **Define isochromat functions** using existing color constants (white, green, blue, red):
   ```javascript
   function IsocTissue1() { let M0 = 1.0;
       return new Isoc(new THREE.Vector3(0, 0, M0), 
           white, nullvec, nElem, true, dR1, dR2, M0, dRadius); }
   ```

2. **Create Substances function** (not wrapper with basicState reset):
   ```javascript
   scenes.Substances2 = function () {
       let isocs = {IsocArr: [IsocTissue1(), IsocTissue2()]};
       isocs.IsocArr[0].dB0 = 0;     // On-resonance
       isocs.IsocArr[1].dB0 = 0.02;  // Slightly off-resonance
       return isocs;
   }
   ```

3. **Add menu items**:
   - HTML: `<li id="Mytissue"><a class="PresetsAction">My Tissue</a></li>`
   - buttonAction: `case "My Tissue" : state.Sample = "My Tissue"; trigSampleChange = true; break;`

4. **Add sampleChange case** with reapplication prevention:
   ```javascript
   case 'My Tissue':
       if (state.Sample == 'My Tissue Internal') break; // Prevent reapplication
       state = Object.assign(state, scenes.Substances2());
       state.T1 = 8; state.T2 = 5; // Set global relaxation times
       state.Sample = 'My Tissue Internal';
       frameFixed = false; break;
   ```

5. **Use predefined colors** (white, green, blue, red) to avoid undefined errors

6. **Calculate dR1/dR2** where effective T1 = 1/(1/T1_global + dR1), T2 = 1/(1/T2_global + dR2)

### Credits

Original: Lars G. Hanson (larsh@drcmr.dk)
License: GNU GPL v3.0
