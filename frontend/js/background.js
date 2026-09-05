// Ambient canvas background for the landing screen — a grid of cells that
// pulse in the brand accent color, brightening near the cursor. Single-hue
// (no green/red gain-loss coding here — that semantic belongs to the charts,
// not decoration) for a calmer, more enterprise feel.
(function () {
  "use strict";

  const canvas = document.getElementById("landingCanvas");
  if (!canvas) return;
  const container = canvas.parentElement;
  if (!container) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const prefersReducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const CELL_SIZE = 26;
  const GAP = 3;
  const INFLUENCE_RADIUS = 130;

  let width = 0;
  let height = 0;
  let cells = [];
  let animationFrameId = null;
  let t = 0;
  const mouse = { x: -9999, y: -9999 };

  function accentRgb() {
    // Read the live --color-accent token so the animation follows the
    // current theme (light/dark) without hardcoding a color here.
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim();
    const probe = document.createElement("span");
    probe.style.color = raw;
    document.body.appendChild(probe);
    const computed = getComputedStyle(probe).color; // "rgb(r, g, b)"
    document.body.removeChild(probe);
    const match = computed.match(/\d+/g);
    return match ? match.slice(0, 3).join(",") : "37,99,235";
  }

  function buildCells() {
    cells = [];
    const cols = Math.ceil(width / (CELL_SIZE + GAP)) + 1;
    const rows = Math.ceil(height / (CELL_SIZE + GAP)) + 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        cells.push({
          x: c * (CELL_SIZE + GAP),
          y: r * (CELL_SIZE + GAP),
          phase: Math.random() * Math.PI * 2,
          speed: 0.4 + Math.random() * 0.8,
        });
      }
    }
  }

  function resize() {
    const rect = container.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, Math.floor(rect.width));
    height = Math.max(1, Math.floor(rect.height));
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildCells();
  }

  function handleMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    mouse.x = e.clientX - rect.left;
    mouse.y = e.clientY - rect.top;
  }

  function handleMouseLeave() {
    mouse.x = -9999;
    mouse.y = -9999;
  }

  function render() {
    const rgb = accentRgb();
    ctx.clearRect(0, 0, width, height);

    // Soft glow that sits directly under the cursor, beneath the cell grid —
    // makes the follow effect legible without needing loud per-cell opacity.
    if (mouse.x > -1000) {
      const glow = ctx.createRadialGradient(mouse.x, mouse.y, 0, mouse.x, mouse.y, INFLUENCE_RADIUS);
      glow.addColorStop(0, `rgba(${rgb}, 0.12)`);
      glow.addColorStop(1, `rgba(${rgb}, 0)`);
      ctx.fillStyle = glow;
      ctx.fillRect(
        mouse.x - INFLUENCE_RADIUS,
        mouse.y - INFLUENCE_RADIUS,
        INFLUENCE_RADIUS * 2,
        INFLUENCE_RADIUS * 2
      );
    }

    cells.forEach((cell) => {
      const raw = Math.sin(t * cell.speed + cell.phase);
      let intensity = Math.abs(raw);

      const cx = cell.x + CELL_SIZE / 2;
      const cy = cell.y + CELL_SIZE / 2;
      const dist = Math.hypot(cx - mouse.x, cy - mouse.y);
      if (dist < INFLUENCE_RADIUS) {
        const boost = 1 - dist / INFLUENCE_RADIUS;
        intensity = Math.min(1, intensity + boost * 0.5);
      }

      ctx.fillStyle = `rgba(${rgb}, ${0.05 + intensity * 0.14})`;
      const r = 4;
      const { x, y } = cell;
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + CELL_SIZE, y, x + CELL_SIZE, y + CELL_SIZE, r);
      ctx.arcTo(x + CELL_SIZE, y + CELL_SIZE, x, y + CELL_SIZE, r);
      ctx.arcTo(x, y + CELL_SIZE, x, y, r);
      ctx.arcTo(x, y, x + CELL_SIZE, y, r);
      ctx.closePath();
      ctx.fill();
    });

    t += 0.02;
    animationFrameId = requestAnimationFrame(render);
  }

  function renderStatic() {
    // Reduced-motion: draw one calm frame, no animation loop, no mouse tracking.
    const rgb = accentRgb();
    ctx.clearRect(0, 0, width, height);
    cells.forEach((cell) => {
      ctx.fillStyle = `rgba(${rgb}, 0.06)`;
      const r = 4;
      const { x, y } = cell;
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + CELL_SIZE, y, x + CELL_SIZE, y + CELL_SIZE, r);
      ctx.arcTo(x + CELL_SIZE, y + CELL_SIZE, x, y + CELL_SIZE, r);
      ctx.arcTo(x, y + CELL_SIZE, x, y, r);
      ctx.arcTo(x, y, x + CELL_SIZE, y, r);
      ctx.closePath();
      ctx.fill();
    });
  }

  resize();
  window.addEventListener("resize", resize);

  if (prefersReducedMotion) {
    renderStatic();
  } else {
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseleave", handleMouseLeave);
    render();
  }

  // Re-render the static frame (or let the loop naturally pick up the new
  // color) when the user toggles light/dark, since the accent token changes.
  const themeObserver = new MutationObserver(() => {
    if (prefersReducedMotion) renderStatic();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  window.addEventListener("beforeunload", () => {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
  });
})();
