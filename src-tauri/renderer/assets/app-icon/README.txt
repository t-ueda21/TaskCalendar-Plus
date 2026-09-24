icon.ico is the Windows window, taskbar, and tray icon.
It is generated from src-tauri/icons/source.png and matches the bundled icon.

To regenerate the icons from the repository root:
  node scripts/make-icon.mjs

Keep the original PNG in src-tauri/icons/source.png. The generator preserves
its aspect ratio and transparency when fitting it onto a square canvas.
