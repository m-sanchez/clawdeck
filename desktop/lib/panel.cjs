function panelBounds(area) {
  const inset = Math.min(8, Math.floor(Math.min(area.width, area.height) / 10));
  const width = Math.min(440, area.width - inset * 2);
  return {
    x: area.x + area.width - width - inset,
    y: area.y + inset,
    width,
    height: area.height - inset * 2,
  };
}
function panelDuration(motion, reducedMotion) {
  return motion === "none" || motion === "reduced" || reducedMotion ? 0 : 220;
}
module.exports = { panelBounds, panelDuration };
