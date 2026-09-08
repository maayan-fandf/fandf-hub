"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Map as LeafletMap } from "leaflet";
import "leaflet/dist/leaflet.css";

/**
 * The targeted radius on a real map — pan, wheel-zoom, streets.
 *
 * WHY A LIBRARY AND NOT MORE OF OUR OWN DRAWING. The hand-drawn locator in
 * AdSetZoneMap answers "roughly where in the country", and it answers it in
 * zero bytes with no network. It cannot answer "which streets does this
 * circle actually cover", because that needs real geometry at street scale.
 * Rather than keep bolting waypoints onto a schematic — the roads in
 * lib/israelMap are already an approximation the UI has to disclaim — this
 * hands the question to a map. The locator stays for the glance; this is for
 * the look.
 *
 * ── TILES, AND THE STATE OF THE FREE OPTIONS (measured 2026-09-09) ──
 * This started on CARTO's basemaps on the belief that they serve without a
 * key. They do not any more: the tiles come back 200 but stamped
 * "API KEY REQUIRED" across every one. Measured against a Ra'anana tile:
 *
 *   tile.openstreetmap.org        200, clean PNG, no key
 *   basemaps.cartocdn.com         200, watermarked
 *   tiles.stadiamaps.com          401 without a key
 *   server.arcgisonline.com       200, clean JPEG, no key
 *
 * So: OSM, until someone decides otherwise. It is the honest default — no
 * key in a client bundle, no account, no secret to grant. The caveat is real
 * and belongs here rather than in a chat message: the OSM Foundation's tile
 * policy asks that heavy or redistributed use get permission first. A map
 * opened by hand a few times a day by the people who run these campaigns is
 * not that, but it is a donated resource being used by a business.
 *
 * THE CLEAN UPGRADE is Stadia Maps: free at this volume, light and dark
 * styles, and authenticated BY DOMAIN — you allowlist hub.fandf.co.il in
 * their dashboard and no key ever enters the bundle. It needs an account,
 * which is why it is not the default here. Switching is this constant plus
 * the attribution line.
 *
 * ── LOADED ONLY WHEN OPENED ──
 * Leaflet is imported dynamically inside the effect, so the ~46KB and its CSS
 * never reach anyone who does not press the button. The creatives tab is
 * already a heavy client component; this must not add to its first paint.
 */

export type MapZone = { label: string; point: [number, number, number] };

export default function AdSetMapModal({
  title,
  zones,
  onClose,
}: {
  title: string;
  zones: MapZone[];
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

    (async () => {
      const L = (await import("leaflet")).default;
      // The user can close the dialog during the import; without this the
      // map initialises into a detached node and leaks its listeners.
      if (cancelled || !hostRef.current) return;

      // OSM serves one style only, so the hub's dark theme gets it back
      // through a CSS filter on the tile layer rather than a dark basemap.
      // See .rpt-cr-mapmodal-map in globals.css.
      const dark =
        document.documentElement.getAttribute("data-theme") === "dark";
      const map = L.map(host, {
        // A view MUST be set before anything is added. Leaflet throws
        // "Cannot read properties of undefined (reading 'layerPointToLatLng')"
        // from inside tileLayer.addTo when the map has no centre yet —
        // fitBounds below is too late. The first zone is the natural seed.
        center: [zones[0].point[0], zones[0].point[1]],
        zoom: 11,
        // No zoom buttons: the wheel and the drag are the whole point, and
        // the panel is small enough that controls eat real estate.
        zoomControl: false,
        attributionControl: true,
        scrollWheelZoom: true,
      });
      mapRef.current = map;

      const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);
      if (dark) tiles.getContainer()?.classList.add("is-darkened");

      const circles = zones.map(({ label, point: [lat, lon, km] }) =>
        L.circle([lat, lon], {
          // Leaflet works in METRES; the export stores kilometres.
          radius: Math.max(km, 0.2) * 1000,
          color: "#10b981",
          weight: 2,
          fillColor: "#10b981",
          fillOpacity: 0.18,
        })
          .addTo(map)
          .bindTooltip(label, { direction: "top" }),
      );

      if (circles.length === 1) {
        map.fitBounds(circles[0].getBounds(), { padding: [24, 24] });
      } else if (circles.length > 1) {
        const b = circles[0].getBounds();
        for (const c of circles.slice(1)) b.extend(c.getBounds());
        map.fitBounds(b, { padding: [24, 24] });
      }
      // Leaflet measures its container on init. Inside a dialog that was
      // display:none a moment ago it reads zero and paints one grey tile in
      // the corner, so remeasure after the browser has laid the panel out.
      requestAnimationFrame(() => map.invalidateSize());
    })();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [zones]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="rpt-cr-mapmodal-back"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="rpt-cr-mapmodal"
        role="dialog"
        aria-modal="true"
        aria-label={`אזור הטירגוט של ${title}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rpt-cr-mapmodal-head">
          <span className="rpt-cr-mapmodal-title">{title}</span>
          <button
            type="button"
            className="rpt-cr-mapmodal-x"
            onClick={onClose}
            aria-label="סגירה"
          >
            ✕
          </button>
        </div>
        <div className="rpt-cr-mapmodal-zones">
          {zones.map((z) => z.label).join(" · ")}
        </div>
        <div ref={hostRef} className="rpt-cr-mapmodal-map" />
      </div>
    </div>,
    document.body,
  );
}
