const { app, Menu, dialog, shell, BrowserWindow } = require("electron");
const { join, resolve } = require("node:path");

const appId = "uk.co.miguelsanchez.ocelin";
const iconPath = app.isPackaged
  ? join(process.resourcesPath, "assets", "ocelin.ico")
  : join(__dirname, "..", "assets", "ocelin.ico");

function brandWindow(window) {
  if (process.platform !== "win32") return;
  const apply = () => {
    window.setIcon(iconPath);
    window.setAppDetails({
      appId,
      appIconPath: iconPath,
      appIconIndex: 0,
      relaunchDisplayName: "Ocelin",
      relaunchCommand: app.isPackaged
        ? `"${process.execPath}" ocelin://dashboard`
        : `"${process.execPath}" "${resolve(__dirname, "..")}" ocelin://dashboard`,
    });
  };
  apply();
  window.on("show", apply);
  window.on("restore", apply);
}

function installMenu(showWindow) {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "&Ocelin",
        submenu: [
          {
            id: "ocelin-dashboard",
            label: "Open dashboard",
            click: () => showWindow("dashboard"),
          },
          {
            id: "ocelin-panel",
            label: "Open session panel",
            click: () => showWindow("tray"),
          },
          { type: "separator" },
          { role: "quit", label: "Quit Ocelin" },
        ],
      },
      { role: "editMenu" },
      {
        label: "&View",
        submenu: [
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "&Help",
        submenu: [
          {
            id: "ocelin-help",
            label: "Ocelin help",
            click: () =>
              shell.openExternal(
                "https://github.com/m-sanchez/ocelin/blob/main/docs/WINDOWS-DESKTOP.md",
              ),
          },
          {
            id: "ocelin-about",
            label: "About Ocelin",
            click: () => {
              const options = {
                title: "About Ocelin",
                message: `Ocelin ${app.getVersion()}`,
                detail:
                  "Your agents, at a glance.\nA local Windows companion for Codex and Claude.\n\nCreated by Miguel Sanchez.",
                icon: join(__dirname, "..", "assets", "ocelin-150.png"),
                buttons: ["Close"],
                noLink: true,
              };
              const parent = BrowserWindow.getFocusedWindow();
              return parent
                ? dialog.showMessageBox(parent, options)
                : dialog.showMessageBox(options);
            },
          },
        ],
      },
    ]),
  );
}

module.exports = { appId, iconPath, brandWindow, installMenu };
