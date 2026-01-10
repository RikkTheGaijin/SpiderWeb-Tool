# SpiderWeb Editor

An interactive 3D tool for creating procedural spiderweb structures with real-time physics simulation. Click to place anchor nodes on surfaces, connect them with physics-driven threads, and export to Maya-compatible formats.

---

## Overview

SpiderWeb Editor lets you design realistic web structures by placing nodes and connections in 3D space. The tool combines intuitive mouse controls with real-time Verlet physics simulation, allowing webs to respond naturally to gravity and constraints. Import custom OBJ meshes as collision surfaces, adjust material properties through a live UI panel, and export finished webs as PLY files for Maya integration.

---

## Main Features

**Interactive Editing**
- Click-to-place node system with automatic surface anchoring
- Real-time thread connections with optional interpolation
- Distance-based spacing (in centimeters) for consistent real-world scale
- Ctrl+drag to reposition nodes, Ctrl+right-drag to cut individual strands
- Undo support (Ctrl+Z) and scene save/load (JSON format)

**Camera Controls**
- Orbit: Middle-mouse drag
- Pan: Ctrl+Middle-drag
- Free-fly navigation: Shift+WASD+Mouse (FPS-style movement)
- Auto-frame scene: Press 'F'

**Physics Simulation**
- Position-based dynamics (PBD) with Verlet integration
- Adjustable gravity, stiffness, damping, and tension parameters
- GPU acceleration via WebGPU (automatic CPU fallback)
- Web Worker threading for non-blocking simulation
- Collision detection against default cube room or custom OBJ meshes

**Maya Integration**
- Export webs as ASCII PLY with embedded metadata
- Included Python script (`PLY_to_Maya_spiderweb.py`) converts PLY to NURBS curves
- Supports multiple imports with automatic group naming
- Preserves original mesh scale and center for round-trip workflows

**Mesh Import**
- Load OBJ files as collision surfaces
- Configurable unit scale (default 0.01 for Maya cm→m conversion)
- Optional wireframe overlay for imported geometry
- Full scene embedding for portable scene files

---

## Technical Features

**Stack**
- TypeScript + Vite for type-safe development and fast builds
- Three.js (WebGL) for rendering with manual geometry updates
- WebGPU compute shaders for particle integration (where available)
- three-mesh-bvh for accelerated raycasting and collision queries
- Web Workers for asynchronous physics computation

**Architecture**
- Modular codebase: separate concerns for scene management, physics, I/O, and UI
- Custom Verlet integrator with iterative constraint solver
- Dual-scale system: UI shows centimeters, internal units match mesh scale
- BVH-accelerated mesh collision with frame-stride optimization
- JSON scene format with embedded OBJ data for portability

**Performance**
- CPU mode: ~5,000 particles @ 60 FPS
- GPU mode: ~50,000+ particles with WebGPU acceleration
- Direct buffer writes minimize Three.js overhead
- Collision complexity reduced to O(log n) per particle via BVH

**Export Format (PLY)**
- ASCII format with custom header comments
- Stores `points_per_strand`, `original_center`, and `original_scale`
- Includes per-vertex anchor flag for fixed points
- Maya script reconstructs curves with correct world-space alignment

---

## Quick Start

```bash
npm install
npm run dev
```
Open browser to `http://localhost:5173`. Use left-click to place nodes, middle-mouse to orbit, Ctrl+left-drag to move nodes. Export via Scene Manager → Export Web, then import PLY into Maya using the included Python script.

### Desktop Build (Electron)

```bash
# Run desktop app with hot reload
npm run electron:dev

# Package portable executable / installer
npm run electron:build
```
`electron:dev` launches Electron pointed at the Vite dev server, so both windows stay in sync. `electron:build` runs the Vite production build and then packages the contents of `dist/` together with the Electron shell via `electron-builder`, producing artifacts under `dist/` and `dist_electron/`.

---

## Browser Support

Requires WebGL-capable browser (Chrome 90+, Firefox 88+, Safari 14+, Edge 90+). WebGPU acceleration available in Chrome/Edge 113+ (optional, auto-fallback to CPU).
