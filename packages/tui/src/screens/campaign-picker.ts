import blessed from "neo-blessed";
import type { Widgets } from "blessed";
import { fetchCampaigns } from "../daemon/campaigns.js";
import type { Campaign } from "../daemon/types.js";

export interface CampaignPicker {
  box: Widgets.BoxElement;
  refresh(): Promise<void>;
}

export function createCampaignPicker(
  screen: Widgets.Screen,
  onSelect: (campaign: Campaign) => void,
): CampaignPicker {
  const box = blessed.box({
    parent: screen,
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    label: " campaigns (enter to open, r to refresh) ",
    border: "line",
  });

  const list = blessed.list({
    parent: box,
    left: 0,
    top: 0,
    width: "100%-2",
    height: "100%-2",
    keys: true,
    vi: true,
    mouse: true,
    style: {
      selected: { inverse: true },
    },
  });

  let campaigns: Campaign[] = [];

  async function refresh(): Promise<void> {
    campaigns = await fetchCampaigns();
    list.setItems(
      campaigns.map((c) => `${c.name}${c.archivedAt ? "  [archived]" : ""}`),
    );
    screen.render();
  }

  list.on("select", (_item: unknown, index: number) => {
    const campaign = campaigns[index];
    if (campaign) onSelect(campaign);
  });

  box.key(["r"], () => {
    void refresh();
  });

  return { box, refresh };
}
