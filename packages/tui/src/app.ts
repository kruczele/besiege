import blessed from "neo-blessed";
import { createCampaignPicker } from "./screens/campaign-picker.js";
import { createTerminalWorkspace } from "./screens/terminal-workspace.js";

export function run(): void {
  const screen = blessed.screen({
    smartCSR: true,
    mouse: true,
    title: "besiege",
  });

  function leaveWorkspace(): void {
    workspace.box.hide();
    picker.box.show();
    picker.box.focus();
    screen.render();
  }

  const workspace = createTerminalWorkspace(screen, leaveWorkspace);
  const picker = createCampaignPicker(screen, (campaign) => {
    workspace.box.show();
    picker.box.hide();
    workspace.box.focus();
    void workspace.open(campaign.id);
  });

  workspace.box.hide();

  // Global quit is only reachable from the picker screen — inside the
  // workspace, all input goes to the focused pty (see pty-pane.ts), reachable
  // again only via Ctrl+B d.
  picker.box.key(["q", "C-c"], () => process.exit(0));

  picker.box.focus();
  void picker.refresh();
  screen.render();
}
