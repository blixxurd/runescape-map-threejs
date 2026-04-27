/**
 * Floating panel listing well-known OSRS locations. Clicking a place
 * teleports the camera to that region's center; the streaming loader
 * picks up the new center and pulls in neighbours on demand.
 *
 * Region IDs are approximate (each location spans multiple regions in
 * the cache) — adjust the table as needed. Hidden under `body.ui-hidden`
 * along with the rest of the chrome.
 */
export interface PlacesPanelHost {
  onTeleport(regionId: number): void;
}

interface Place {
  name: string;
  regionId: number;
}

const PLACES: Place[] = [
  { name: "Lumbridge", regionId: 12850 },
  { name: "Draynor Village", regionId: 12338 },
  { name: "Varrock", regionId: 12853 },
  { name: "Edgeville", regionId: 12342 },
  { name: "Al Kharid", regionId: 13105 },
  { name: "Falador", regionId: 11828 },
  { name: "Burthorpe", regionId: 11577 },
  { name: "Catherby", regionId: 11317 },
  { name: "Camelot", regionId: 11061 },
  { name: "Ardougne", regionId: 10548 },
  { name: "Yanille", regionId: 10288 },
  { name: "Brimhaven", regionId: 11050 },
];

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    #placesPanel {
      /* Stacks directly above the EnvironmentPanel (bottom-left). The
         envPanel hovers ~110px tall; we leave a small gap. If you change
         envPanel layout, retune this offset. */
      position: fixed; bottom: 120px; left: 8px;
      width: 260px;
      background: rgba(0,0,0,0.70); color: #d5dce8;
      border: 1px solid #2a334a; border-radius: 4px;
      font: 11px ui-monospace, SFMono-Regular, Menlo, monospace;
      z-index: 10;
      display: flex; flex-direction: column;
    }
    #placesPanel.collapsed .body { display: none; }
    #placesPanel .head {
      display: flex; justify-content: space-between; align-items: center;
      padding: 4px 8px; border-bottom: 1px solid #2a334a;
      color: #7aa6d6; font-weight: bold;
    }
    #placesPanel .head .collapse {
      background: transparent; border: none; color: #8f9bb5;
      font: inherit; cursor: pointer; padding: 0 4px;
    }
    #placesPanel .head .collapse:hover { color: #e6e8ec; }
    #placesPanel .body {
      max-height: 280px; overflow-y: auto;
    }
    #placesPanel button.row {
      display: flex; justify-content: space-between; gap: 8px;
      width: 100%; padding: 4px 8px;
      background: transparent; border: none; border-bottom: 1px solid #14192a;
      color: #d5dce8; font: inherit; cursor: pointer; text-align: left;
    }
    #placesPanel button.row:last-child { border-bottom: none; }
    #placesPanel button.row:hover { background: #1a2138; color: #e6e8ec; }
    #placesPanel button.row .id {
      color: #8f9bb5; font-size: 10.5px;
    }
    body.ui-hidden #placesPanel { display: none !important; }
  `;
  document.head.appendChild(style);
}

export class PlacesPanel {
  private readonly host: PlacesPanelHost;
  private readonly root: HTMLDivElement;

  constructor(host: PlacesPanelHost) {
    this.host = host;
    injectStyles();

    this.root = document.createElement("div");
    this.root.id = "placesPanel";
    this.root.innerHTML = `
      <div class="head">
        <span>places</span>
        <button class="collapse" type="button" title="collapse">–</button>
      </div>
      <div class="body">
        ${PLACES.map(
          (p) =>
            `<button class="row" type="button" data-region="${p.regionId}">` +
            `<span class="name">${p.name}</span>` +
            `<span class="id">${p.regionId}</span>` +
            `</button>`,
        ).join("")}
      </div>
    `;
    document.body.appendChild(this.root);

    this.root
      .querySelector<HTMLButtonElement>(".collapse")!
      .addEventListener("click", () => this.root.classList.toggle("collapsed"));

    this.root.querySelectorAll<HTMLButtonElement>("button.row").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = Number(btn.dataset.region);
        if (Number.isFinite(id)) this.host.onTeleport(id);
      });
    });
  }
}
