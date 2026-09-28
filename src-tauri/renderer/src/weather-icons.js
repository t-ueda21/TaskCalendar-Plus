// Lucide 0.468.0. See ../assets/licenses/lucide.txt (ISC and Feather MIT).
// Vendored shapes keep weather icons available offline, without a runtime dependency.
const ICONS = Object.freeze({
  "sun": [["circle",{"cx":"12","cy":"12","r":"4"}],["path",{"d":"M12 2v2"}],["path",{"d":"M12 20v2"}],["path",{"d":"m4.93 4.93 1.41 1.41"}],["path",{"d":"m17.66 17.66 1.41 1.41"}],["path",{"d":"M2 12h2"}],["path",{"d":"M20 12h2"}],["path",{"d":"m6.34 17.66-1.41 1.41"}],["path",{"d":"m19.07 4.93-1.41 1.41"}]],
  "sun-medium": [["circle",{"cx":"12","cy":"12","r":"4"}],["path",{"d":"M12 3v1"}],["path",{"d":"M12 20v1"}],["path",{"d":"M3 12h1"}],["path",{"d":"M20 12h1"}],["path",{"d":"m18.364 5.636-.707.707"}],["path",{"d":"m6.343 17.657-.707.707"}],["path",{"d":"m5.636 5.636.707.707"}],["path",{"d":"m17.657 17.657.707.707"}]],
  "cloud-sun": [["path",{"d":"M12 2v2"}],["path",{"d":"m4.93 4.93 1.41 1.41"}],["path",{"d":"M20 12h2"}],["path",{"d":"m19.07 4.93-1.41 1.41"}],["path",{"d":"M15.947 12.65a4 4 0 0 0-5.925-4.128"}],["path",{"d":"M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"}]],
  "cloud": [["path",{"d":"M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"}]],
  "cloud-fog": [["path",{"d":"M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"}],["path",{"d":"M16 17H7"}],["path",{"d":"M17 21H9"}]],
  "cloud-drizzle": [["path",{"d":"M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"}],["path",{"d":"M8 19v1"}],["path",{"d":"M8 14v1"}],["path",{"d":"M16 19v1"}],["path",{"d":"M16 14v1"}],["path",{"d":"M12 21v1"}],["path",{"d":"M12 16v1"}]],
  "cloud-rain": [["path",{"d":"M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"}],["path",{"d":"M16 14v6"}],["path",{"d":"M8 14v6"}],["path",{"d":"M12 16v6"}]],
  "snowflake": [["line",{"x1":"2","x2":"22","y1":"12","y2":"12"}],["line",{"x1":"12","x2":"12","y1":"2","y2":"22"}],["path",{"d":"m20 16-4-4 4-4"}],["path",{"d":"m4 8 4 4-4 4"}],["path",{"d":"m16 4-4 4-4-4"}],["path",{"d":"m8 20 4-4 4 4"}]],
  "cloud-sun-rain": [["path",{"d":"M12 2v2"}],["path",{"d":"m4.93 4.93 1.41 1.41"}],["path",{"d":"M20 12h2"}],["path",{"d":"m19.07 4.93-1.41 1.41"}],["path",{"d":"M15.947 12.65a4 4 0 0 0-5.925-4.128"}],["path",{"d":"M3 20a5 5 0 1 1 8.9-4H13a3 3 0 0 1 2 5.24"}],["path",{"d":"M11 20v2"}],["path",{"d":"M7 19v2"}]],
  "cloud-snow": [["path",{"d":"M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"}],["path",{"d":"M8 15h.01"}],["path",{"d":"M8 19h.01"}],["path",{"d":"M12 17h.01"}],["path",{"d":"M12 21h.01"}],["path",{"d":"M16 15h.01"}],["path",{"d":"M16 19h.01"}]],
  "cloud-lightning": [["path",{"d":"M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973"}],["path",{"d":"m13 12-3 5h4l-3 5"}]],
  "thermometer": [["path",{"d":"M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"}]],
});

export function createWeatherIcon(name, doc = document) {
  const key = Object.hasOwn(ICONS, name) ? name : "thermometer";
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  const attributes = {
    viewBox: "0 0 24 24", width: "18", height: "18", fill: "none",
    stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round",
    "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false",
    class: "weatherIcon", "data-weather-icon": key,
  };
  for (const [attribute, value] of Object.entries(attributes)) svg.setAttribute(attribute, value);
  for (const [tag, attributes] of ICONS[key]) {
    const shape = doc.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [attribute, value] of Object.entries(attributes)) shape.setAttribute(attribute, value);
    svg.appendChild(shape);
  }
  return svg;
}
