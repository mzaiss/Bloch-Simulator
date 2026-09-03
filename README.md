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

Plot rows follow the 3D view's colours: RF magnitude in **yellow** (like the B1 arrow), RF phase **orange**, GX **blue**, GY **green**, GZ **violet**, ADC **red**. The whole sequence is shown at once — there is no wheel zoom and no time slider — and each row is drawn as a min/max envelope, so a fast waveform such as a spiral readout shows its true bounds instead of an aliased line. GX and GY are played as independent channels, so oblique gradients (both on at once, as in the FLASH prewinder or the EPI blips) dephase along a diagonal. GZ is plotted but does not act on the sample, which lies in the xy plane.

Playback **integrates** the waveforms over each animation frame rather than sampling them once, and splits the frame into several Bloch steps while RF is on. Flip angles and gradient moments therefore come out the same at any frame rate and at any playback speed. The speed slider is logarithmic and spans 0.002× to 5×; the slow end is what makes an individual gradient lobe readable, since a strong gradient can wind more than half a turn per frame at 5×.

**normalized gradients** scales the gradients so the outermost k-space sample the sequence acquires winds five turns across the sample, whatever field of view and matrix the sequence was written for. What a sequence asks of its gradients follows from those two numbers, and our sample has neither: the Cartesian examples image a 1 m field of view at 16×16 and reach 11 1/m, while the spiral images 24 cm at 120×120 and reaches 594 1/m. Played as written, the first three barely dephase the sample and the spiral overruns it into pure aliasing at any playback speed. Normalized they are all amplified or damped onto the same winding — ×3.8 for FLASH, RARE and EPI, ×0.070 for the spiral — which makes them comparable with each other and keeps them at half of what the 0.4-unit isochromat spacing can resolve, so the stripes read as stripes rather than folding. The target is capped at that resolution limit for coarser samples. The panel reports the factor applied. Unchecked, gradients play at their physical strength.

The k-space this is measured on comes from `Pulseq.calculateKspace`, a port of pypulseq's `Sequence.calculate_kspace`: the running gradient moment, restarted at every excitation pulse because it makes fresh transverse magnetization, and mirrored through the origin at every refocusing pulse because it inverts the phase accrued so far. Both matter for an echo train — integrating the gradients straight through from the start of the file reads RARE as winding 79 turns across the sample where a spin actually carries 2.4. The tests pin the result to the textbook answer: every ADC sample of the three Cartesian examples lands on their 1 1/m grid, k<sub>x</sub> sweeping −7.5 to 7.5 and k<sub>y</sub> stepping in whole units.

Which pulses count as excitation and which as refocusing is stated outright by a v1.5 file, in the `use` field the format gained in that revision, and the file is taken at its word — including that inversion, saturation and preparation pulses act on longitudinal magnetization and so leave the trajectory alone. Below v1.5 it has to be inferred: pulses up to 90.01° are treated as excitation and larger ones as refocusing, the same rule pypulseq applies in `read(detect_rf_use=True)`. The inference is what the field exists to replace — it misreads a refocusing pulse driven below 90° to save power, and an inversion pulse looks the same to it as a refocusing one.

### File format versions

Formats **v1.2 through v1.5** are read. Each revision inserted columns into the middle of the event tables, so the layout is chosen by the version in the file: v1.4 added a `time_id` to RF and gradient events, and v1.5 added a `center` and `use` to RF, `first` and `last` to arbitrary gradients, and parts-per-million frequency and phase offsets to both RF and ADC. Reading a v1.5 file on the v1.4 layout takes the pulse centre for its delay and the first gradient sample for its shape id, which parses cleanly and means nothing — so a file newer than this parser is reported in the panel rather than read on the newest layout it happens to know.

`tests/fixtures/v15_tse_8.seq` is a v1.5 spin echo train written by pypulseq 1.5, kept as a regression test for all of this. Its refocusing pulses are driven at 60° and an inversion pulse leads the train, so the flip-angle rule would find five excitations where the `use` field finds one; its slice select is a shaped gradient, so the v1.5 gradient columns have to be consumed to see it at all. Every k-space value the test asserts is one pypulseq's own `calculate_kspace` agrees with to the digit.

Sequences are rasterized at half the finest raster the file declares — 0.5 µs for a typical 1 µs RF raster — so gradient corners and RF samples land on the grid. Very long sequences fall back to a coarser step to stay within a 300k-sample budget. Gradients defined with a Pulseq **time shape** (extended trapezoids and other non-uniform shapes, `time_id` from v1.4) are read at their own sample times; those without one step at raster centres, sample *i* covering the interval from *i* to *i*+1 rasters, so a shaped gradient's area is exactly the raster times the sum of its samples.

Example sequences (from [MRTwin_pulseq BlochSimWeb](https://github.com/mzaiss/MRTwin_pulseq/tree/mr0-core/BlochSimWeb)):

- `seq/web1_FID.seq` — block-pulse FID, flip angles 30°…360°
- `seq/web2_SpinEcho_me.seq` — 90° then a train of 180°s, refocusing 90° from the excitation (CPMG)
- `seq/web2_SpinEcho_nonCPMG.seq` — the same timing with all RF phases 0, so refocusing is along the excitation axis
- `seq/web2_SpinEcho_sinc.seq` — sinc-pulse spin echo
- `seq/web3_FLASH_16.seq` — 16-line FLASH
- `seq/web4_RARE_16.seq` — 16-echo RARE
- `seq/web5_EPI_16.seq` — 16-line EPI
- `seq/spiral_tse_ss.seq` — 4-echo spiral TSE (Pulseq v1.4.2, time-shaped spiral gradients), CPMG with the 180°s 90° from the excitation; the 0.5 s TR delay block at the end of the generated file was removed, and `TotalDuration` reduced to match

The spiral example is generated by `spiral_tse_ss.py` in the MR-agents sandbox. Its variable-density trajectory used to diverge a third of the way through the first readout, reaching 2331 mT/m against the 35 mT/m its own generator declared, because MATLAB-normalised FOV coefficients (`FOV(r) = Σ Fcoeff[i]·(r/rmax)^i`) were passed to a `calc_vds` that reads them as absolute in `r`. The generator now rescales them and checks the trajectory against the system limits, since the readout gradients are built with pypulseq's own limit checks disabled.

Two later changes to that generator: the refocusing pulses are phased 90° from the excitation, which is what makes the train CPMG — driven along the excitation axis instead, every pulse's flip angle error accumulates down the train rather than alternating and cancelling. And both pulses are half as long at the same flip angle (1.25 ms and 1 ms, at twice the amplitude), which shortens the sequence from 109.7 ms to 104.9 ms.

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
