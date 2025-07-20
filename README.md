# Bloch-Simulator
Bloch Simulator for NMR and MRI education

## 🚀 GitHub Pages Compatibility Release

This fork includes modifications to make the Bloch Simulator compatible with GitHub Pages hosting while maintaining full functionality.

### 📋 Changes from Original Hanson Version

#### ✅ **Core Fixes**
- **ES6 Module Compatibility**: Replaced ES6 `import` statements with traditional `<script>` tags for GitHub Pages compatibility
- **THREE.js Version**: Downgraded from v0.132.2 to v0.124.0 to maintain `THREE.Geometry` constructor support
- **OrbitControls**: Fixed reference from `new OrbitControls()` to `new THREE.OrbitControls()`
- **Dependency Loading**: Added error checking for failed library loads

#### 🔧 **Technical Changes**
```diff
- <script type="module">
- import * as THREE from "https://unpkg.com/three/build/three.module.js";
+ <script src="https://unpkg.com/three@0.124.0/build/three.min.js"></script>
+ <script>
```

#### 📦 **Dependencies Updated**
- **THREE.js**: v0.124.0 (UMD build)
- **OrbitControls**: v0.124.0 (compatible version)
- **dat.gui**: v0.7.7 (UMD build)
- **jQuery**: v3.5.1 (unchanged)
- **jQuery UI**: v1.12.1 (unchanged)

#### 🌐 **Hosting Options**

| Method | Works Offline | GitHub Pages | Local File | Notes |
|--------|---------------|--------------|------------|-------|
| **This Version** | ❌ (needs CDN) | ✅ | ✅ | Best for development |
| **Original** | ❌ | ❌ | ❌ | ES6 modules incompatible |

#### 🎯 **Usage**

**GitHub Pages:**
1. Fork this repository
2. Enable GitHub Pages in Settings
3. Access at: `https://yourusername.github.io/Bloch-Simulator`

**Local Development:**
1. Clone repository
2. Double-click `index.html` (requires internet for CDN dependencies)
3. Or serve locally: `python -m http.server 8000`

#### 🔄 **Backward Compatibility**
- ✅ All original physics simulation features preserved
- ✅ Same T1/T2 modification methods
- ✅ Identical user interface and controls
- ✅ Compatible with original documentation

#### 🧪 **Mixed Matter Configurations**

**Current "Mixed matter" (3 substances):**

| Substance | Color | T1 (s) | T2 (s) | M0 | dB0 | Notes |
|-----------|-------|--------|--------|----|----|-------|
| 1 | Blue | 5.0 | 5.0 | 1.0 | 0 | Generic tissue |
| 2 | Green | ∞ | ∞ | 0.91 | -0.04 | No relaxation |
| 3 | White | ∞ | 5.0 | 0.91 | 0.04 | T2-only relaxation |

**New "Brain tissue" (2 substances):**

| Substance | Color | T1 (s) | T2 (s) | M0 | dB0 | Tissue Type |
|-----------|-------|--------|--------|----|----|-------------|
| 1 | Gray | 1.33 | 0.1 | 1.0 | 0 | Gray Matter (3T) |
| 2 | Cyan | 4.3 | 2.1 | 0.95 | 0.02 | CSF (3T) |

*Note: Brain tissue values are realistic for 3 Tesla MRI*

### 🐛 **Known Issues**
- Requires internet connection for CDN dependencies
- Some older browsers may have CORS restrictions with local files

### 🙏 **Credits**
- **Original Author**: Lars G. Hanson (larsh@drcmr.dk, lghan@dtu.dk)
- **GitHub Pages Adaptation**: Community contribution
- **License**: GNU General Public License v3.0

---
