# Bloch Simulator
Bloch simulator for NMR and MRI education.

## GitHub Pages Compatibility

This fork modifies the original Hanson version for GitHub Pages hosting.

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
Local: Clone and open index.html (requires internet for CDN dependencies)

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
