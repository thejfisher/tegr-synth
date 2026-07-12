@echo off
echo.
echo  ═══════════════════════════════════════════
echo   TEGR SYNTHESIZER - Resonant Wave Defect
echo   Starting local audio server...
echo  ═══════════════════════════════════════════
echo.
echo  Open http://localhost:8080 in your browser
echo  Press Ctrl+C to stop the server
echo.
start http://localhost:8080
python -m http.server 8080
