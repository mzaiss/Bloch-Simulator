# Bloch Simulator

Interactive Bloch simulator for NMR and MRI education.

## GitHub Pages Compatibility

This fork modifies the original Hanson version for GitHub Pages hosting.

### Changes Made

- Replaced ES6 module imports with script tags for browser compatibility
- Downgraded THREE.js from v0.132.2 to v0.124.0 to maintain THREE.Geometry support
- Fixed OrbitControls reference and added dependency error checking

### Dependencies

- THREE.js v0.124.0, OrbitControls v0.124.0, dat.gui v0.7.7
- jQuery v3.5.1, jQuery UI v1.12.1

### Usage

GitHub Pages: Fork repository, enable Pages in settings
Local: Clone and open index.html (requires internet for CDN dependencies)

### Mixed Matter Presets

Mixed matter (3 substances):
- Blue: T1=5.0s, T2=5.0s, generic tissue
- Green: T1=∞, T2=∞, no relaxation  
- White: T1=∞, T2=5.0s, T2-only relaxation

Brain tissue (2 substances):
- Gray: T1=1.33s, T2=0.1s, gray matter at 3T
- Cyan: T1=4.3s, T2=2.1s, CSF at 3T

### Credits

Original: Lars G. Hanson (larsh@drcmr.dk)
License: GNU GPL v3.0
