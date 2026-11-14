import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "gleasonmt.dfw-mtb"
  ipcTarget: "gleasonmt.dfw-mtb"
  manageIpc: false

  // ---- Settings (inline on the bar entry in shell.json) ---------------------

  readonly property string barMode: ["favorites", "count", "nearest"].indexOf(setting("barMode", "favorites")) >= 0 ? setting("barMode", "favorites") : "favorites"
  readonly property string alerts: ["favorites", "all", "off"].indexOf(setting("alerts", "favorites")) >= 0 ? setting("alerts", "favorites") : "favorites"
  readonly property string sortMode: ["nearest", "name", "status"].indexOf(setting("sort", "nearest")) >= 0 ? setting("sort", "nearest") : "nearest"
  readonly property string unit: setting("unit", "mi") === "km" ? "km" : "mi"
  readonly property var favorites: Model.parseFavorites(setting("favorites", []))

  // ---- Data -----------------------------------------------------------------

  // DFW MTB Trail Hub's public API (https://dfwmtbtrailhub.com/developers).
  // The site's CDN caches it for five minutes; every bar on every monitor
  // shares one cached copy, refreshed when it is older than this.
  readonly property string trailsUrl: "https://dfwmtbtrailhub.com/api/v1/trails"
  readonly property string changesUrl: "https://dfwmtbtrailhub.com/api/v1/status-changes"
  readonly property string cacheDir: (Quickshell.env("XDG_CACHE_HOME") || (Quickshell.env("HOME") + "/.cache")) + "/gleasonmt-dfw-mtb"
  readonly property int maxAgeMinutes: 15
  readonly property int geoMaxAgeMinutes: 1440

  property var feed: ({ ok: false, generatedAt: null, trails: [] })
  property var changes: []
  property bool fetchFailed: false

  // Where you are, for "nearest": Omarchy's Weather location when one is set
  // (omarchy-weather-location); a name-only one is respected, not replaced.
  // Only with no Weather location at all does it ask geo.omarchy.org, the
  // lookup the Weather panel makes.
  property var configuredLocation: null
  property var detectedLocation: null
  property bool configuredLoaded: false
  readonly property bool usingWeatherLocation: configuredLocation !== null
  readonly property var origin: usingWeatherLocation
    ? (Model.hasCoordinates(configuredLocation) ? configuredLocation : null)
    : detectedLocation

  property double now: Date.now()
  // Status changes older than this aren't notified, so a fresh install or a
  // shell restart doesn't replay a backlog. Six hours back, because a change
  // is dated when the club posted it, which can be a while before the site
  // reads it. Each change is notified at most once anyway (notify.sh).
  readonly property double alertsSince: Date.now() - 6 * 3600 * 1000

  readonly property var trails: Model.arrange(feed.trails, origin, unit, favorites, sortMode)
  readonly property var favoriteTrails: Model.favoritesOf(trails)
  readonly property int openCount: Model.countOpen(trails)
  readonly property string barLabel: Model.barLabel(barMode, trails)
  readonly property bool barAlert: Model.barAlert(barMode, trails)
  readonly property var recentChanges: changes.slice(0, 3)

  // ---- Panel cursor ---------------------------------------------------------

  // Rows, top to bottom: favorites, "All trails" (and, while it is open,
  // every other trail), recent changes, the site, "Filter options" (and,
  // while it is open, Show in bar, Alerts, Sort, Units).
  property int rowIndex: 0
  property bool cursorActive: false
  // Open by default until you have favorites; stays as you left it until the
  // shell restarts.
  property bool allOpenChoice: false
  property bool allChosen: false
  readonly property bool allOpen: allChosen ? allOpenChoice : favoriteTrails.length === 0
  property bool optionsOpen: false

  readonly property var otherTrails: trails.filter(function(t) { return !t.favorite })
  readonly property int favCount: favoriteTrails.length
  readonly property int allRow: favCount
  readonly property int otherStart: allRow + 1
  readonly property int otherCount: allOpen ? otherTrails.length : 0
  readonly property int changeStart: otherStart + otherCount
  readonly property int siteRow: changeStart + recentChanges.length
  readonly property int optionsRow: siteRow + 1
  readonly property int barModeRow: optionsOpen ? optionsRow + 1 : -1
  readonly property int alertsRow: optionsOpen ? optionsRow + 2 : -1
  readonly property int sortRow: optionsOpen ? optionsRow + 3 : -1
  readonly property int unitRow: optionsOpen ? optionsRow + 4 : -1
  readonly property int rowCount: optionsRow + (optionsOpen ? 5 : 1)

  readonly property color foreground: bar ? bar.foreground : Commons.Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  function statusColor(s) {
    return s === "closed" ? Commons.Color.urgent : s === "caution" ? Commons.Color.accent : root.foreground
  }

  function statusGlyph(s) {
    return s === "closed" ? "\u{f0159}" : s === "caution" ? "\u{f0026}" : "\u{f05e0}"
  }

  function trailAt(i) {
    if (i < favCount) return favoriteTrails[i]
    if (i >= otherStart && i < changeStart) return otherTrails[i - otherStart]
    return null
  }

  function openUrl(url) {
    if (String(url).indexOf("https://dfwmtbtrailhub.com/") !== 0) return
    Quickshell.execDetached(["omarchy-launch-browser", url])
    root.close()
  }

  function activateRow(i, direction) {
    var t = trailAt(i)
    if (t) {
      if (direction < 0) toggleFavorite(t.slug)
      else openUrl(t.url)
    } else if (i === allRow) {
      allOpenChoice = !allOpen
      allChosen = true
    } else if (i >= changeStart && i < siteRow) openUrl(recentChanges[i - changeStart].url)
    else if (i === siteRow) openUrl("https://dfwmtbtrailhub.com/")
    else if (i === optionsRow) optionsOpen = !optionsOpen
    else if (i === barModeRow) setSetting("barMode", Model.cycle(barMode, ["favorites", "count", "nearest"], direction || 1))
    else if (i === alertsRow) setSetting("alerts", Model.cycle(alerts, ["favorites", "all", "off"], direction || 1))
    else if (i === sortRow) setSetting("sort", Model.cycle(sortMode, ["nearest", "name", "status"], direction || 1))
    else if (i === unitRow) setSetting("unit", unit === "km" ? "mi" : "km")
  }

  function toggleFavorite(id) {
    setSetting("favorites", Model.toggleFavorite(favorites, id))
  }

  // Settings live on this widget's entry in shell.json, written the way
  // `omarchy bar set ... --json` writes them; the shell hands the new value
  // straight back through `settings`.
  function setSetting(key, value) {
    Quickshell.execDetached(["omarchy-bar", "set", "gleasonmt.dfw-mtb", key, JSON.stringify(value), "--json"])
  }

  // fetch.sh, next to this file: https only, size-capped, one download at a
  // time per file across monitors, written privately. The trail list is
  // about 130 KB today; 2 MB leaves room, and parseTrails caps every field.
  readonly property string fetchScript: decodeURIComponent(String(Qt.resolvedUrl("fetch.sh")).replace(/^file:\/\//, ""))
  readonly property string notifyScript: decodeURIComponent(String(Qt.resolvedUrl("notify.sh")).replace(/^file:\/\//, ""))
  readonly property string stateDir: (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state")) + "/gleasonmt-dfw-mtb/notified"

  // "started", or "busy" when a download is already running in this bar.
  function refresh(force) {
    if (trailsProc.running) return "busy"
    var age = String(force ? 0 : maxAgeMinutes)
    trailsProc.command = ["bash", fetchScript, cacheDir, "trails.json", trailsUrl, age, "2000000"]
    trailsProc.running = true
    if (!changesProc.running) {
      changesProc.command = ["bash", fetchScript, cacheDir, "changes.json", changesUrl, age, "500000"]
      changesProc.running = true
    }
    return "started"
  }

  function detectLocation() {
    if (geoProc.running || !configuredLoaded || configuredLocation !== null) return
    geoProc.command = ["bash", fetchScript, cacheDir, "location.json", "https://geo.omarchy.org/",
      String(geoMaxAgeMinutes), "4096"]
    geoProc.running = true
  }

  Process {
    id: trailsProc
    // 2 means another monitor's bar holds the download; its result reaches
    // this one through the file watch.
    onExited: function(code) {
      if (code !== 2) root.fetchFailed = code !== 0
      trailsFile.reload()
    }
  }

  Process {
    id: changesProc
    onExited: changesFile.reload()
  }

  Process {
    id: geoProc
    onExited: geoFile.reload()
  }

  FileView {
    id: trailsFile
    path: root.cacheDir + "/trails.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      var parsed = Model.parseTrails(text())
      if (parsed.ok) root.feed = parsed
    }
  }

  FileView {
    id: changesFile
    path: root.cacheDir + "/changes.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.changes = Model.parseChanges(text())
  }

  FileView {
    id: weatherFile
    path: Quickshell.env("HOME") + "/.local/state/omarchy/settings/weather.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      root.configuredLocation = Model.parseLocation(text())
      root.configuredLoaded = true
      root.detectLocation()
    }
    onLoadFailed: {
      root.configuredLocation = null
      root.configuredLoaded = true
      root.detectLocation()
    }
  }

  FileView {
    id: geoFile
    path: root.cacheDir + "/location.json"
    printErrors: false
    onLoaded: root.detectedLocation = Model.parseLocation(text())
  }

  // ---- Alerts ---------------------------------------------------------------

  // notify.sh records each change it announces, under a lock, so one status
  // change gives one notification however many monitors have a bar.
  // sentHere only saves asking it again on every refresh.
  property var sentHere: ({})

  function checkAlerts() {
    var due = Model.alertsDue(changes, alerts, favorites, alertsSince)
    for (var i = 0; i < due.length; i++) {
      var c = due[i]
      var key = Qt.md5("change|" + c.id)
      if (sentHere[key]) continue
      sentHere[key] = true
      var t = Model.alertText(c)
      // Clicking it opens the trail's page on the Trail Hub; the link is one
      // argument, never parsed by a shell.
      Quickshell.execDetached(["bash", notifyScript, stateDir, key,
        "--app-name", "DFW MTB Trail Hub", "-g", root.statusGlyph(c.status), "-u", "normal",
        t.headline, t.body, "--exec", "omarchy-launch-browser", c.url])
    }
  }

  onChangesChanged: checkAlerts()
  onAlertsChanged: checkAlerts()
  onFavoritesChanged: checkAlerts()

  // Every 15 minutes: the fetch script only downloads when the cached copy
  // is stale.
  Timer {
    interval: 15 * 60 * 1000
    running: true
    repeat: true
    onTriggered: {
      root.refresh(false)
      weatherFile.reload()
      root.detectLocation()
    }
  }

  // "reported 5 min ago" follows the clock.
  Timer {
    interval: 60 * 1000
    running: true
    repeat: true
    onTriggered: root.now = Date.now()
  }

  Component.onCompleted: refresh(false)

  // ---- Bar ------------------------------------------------------------------

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: if (opened) {
    now = Date.now()
    weatherFile.reload()
    refresh(false)
    cursorActive = false
    rowIndex = 0
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { return root.refresh(true) }
  }

  TextMetrics {
    id: labelMetrics
    font.family: button.fontFamily
    font.pixelSize: Style.bar.iconFont
    text: root.barLabel
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "\u{f00a3}"
    dimmed: root.feed.trails.length === 0
    labelText: root.bar && root.bar.vertical ? "" : root.barLabel
    slotSize: labelText !== "" ? Style.bar.iconSlot + labelMetrics.advanceWidth + Style.space(6) : Style.bar.iconSlot
    tooltipText: {
      if (!root.feed.trails.length) return "DFW MTB Trail Hub: loading trails"
      var lines = []
      var favs = root.favoriteTrails
      for (var i = 0; i < favs.length && i < 6; i++)
        lines.push(favs[i].name + ": " + Model.statusWord(favs[i].shown).toLowerCase() + ", reported " + Model.ago(favs[i].reportedAt, root.now))
      lines.push(root.openCount + " of " + root.trails.length + " DFW trails open")
      return lines.join("\n")
    }
    onPressed: function(b) {
      if (b === Qt.MiddleButton) root.refresh(true)
      else root.toggle()
    }
  }

  // A closed favorite (or nearest trail) marks the bar with your theme's
  // urgent color, under the label.
  Rectangle {
    visible: root.barAlert && !(root.bar && root.bar.vertical)
    anchors.horizontalCenter: button.horizontalCenter
    anchors.bottom: button.bottom
    anchors.bottomMargin: Style.space(2)
    width: Math.max(Style.space(8), labelMetrics.advanceWidth * 0.6)
    height: Style.space(2)
    radius: height / 2
    color: Commons.Color.urgent
  }

  // ---- Panel ----------------------------------------------------------------

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(430))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(860))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) { root.cursorActive = true; return }
        if (dx !== 0 && dy === 0 && root.optionsOpen && root.rowIndex >= root.barModeRow) {
          root.activateRow(root.rowIndex, dx > 0 ? 1 : -1)
          return
        }
        root.rowIndex = Math.max(0, Math.min(root.rowCount - 1, root.rowIndex + dy))
      }
      onActivateRequested: if (root.cursorActive) root.activateRow(root.rowIndex, 1)
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        var k = t.toLowerCase()
        if (k === "r") root.refresh(true)
        else if ((k === "f" || k === "s") && root.cursorActive) {
          var trail = root.trailAt(root.rowIndex)
          if (trail) root.toggleFavorite(trail.slug)
        }
      }

      Flickable {
        id: flick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          x: Style.space(2)
          width: flick.width - Style.space(4)
          spacing: Style.space(10)

          PanelHero {
            width: parent.width
            foreground: root.foreground
            fontFamily: root.fontFamily
            iconComponent: Component {
              Text {
                text: "\u{f00a3}"
                color: root.barAlert ? Commons.Color.urgent : root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.display
              }
            }
            title: !root.feed.trails.length ? (root.fetchFailed ? "Couldn't reach the Trail Hub" : "Loading trails…")
              : root.favCount ? Model.countOpen(root.favoriteTrails) + " of " + root.favCount + " favorites open"
              : root.openCount + " of " + root.trails.length + " trails open"
            meta: root.feed.trails.length
              ? (root.favCount ? root.openCount + " of " + root.trails.length + " DFW trails open" : "Star your trails to follow them")
              : "dfwmtbtrailhub.com"
          }

          PanelSeparator { foreground: root.foreground }

          PanelSectionHeader {
            visible: root.favCount > 0
            foreground: root.foreground
            fontFamily: root.fontFamily
            text: "Favorites"
          }

          Column {
            visible: root.favCount > 0
            width: parent.width
            spacing: Style.space(2)
            Repeater {
              model: root.favoriteTrails
              TrailRow {
                required property var modelData
                required property int index
                width: parent.width
                rowIndex: index
                trail: modelData
              }
            }
          }

          MeetRow {
              width: parent.width
              rowIndex: root.allRow
              glyph: root.allOpen ? "\u{f0140}" : "\u{f0142}"
              label: (root.favCount ? "All other trails" : "All trails") + " · " + Model.sortLabel(root.sortMode)
              caption: root.allOpen
                ? "Click: trail page · right-click or ☆: favorite"
                : root.otherTrails.length + " trails, " + Model.countOpen(root.otherTrails) + " open"
              onActivated: root.activateRow(root.allRow, 1)
          }

          Column {
            visible: root.allOpen
            width: parent.width
            spacing: Style.space(2)
            Repeater {
              model: root.allOpen ? root.otherTrails : []
              TrailRow {
                required property var modelData
                required property int index
                width: parent.width
                rowIndex: root.otherStart + index
                trail: modelData
              }
            }
          }

          PanelSeparator {
            visible: root.recentChanges.length > 0
            foreground: root.foreground
          }

          PanelSectionHeader {
            visible: root.recentChanges.length > 0
            foreground: root.foreground
            fontFamily: root.fontFamily
            text: "Recent changes"
          }

          Column {
            visible: root.recentChanges.length > 0
            width: parent.width
            spacing: Style.space(2)
            Repeater {
              model: root.recentChanges
              MeetRow {
                required property var modelData
                required property int index
                width: parent.width
                rowIndex: root.changeStart + index
                glyph: root.statusGlyph(modelData.status)
                glyphColor: root.statusColor(modelData.status)
                label: modelData.name
                caption: Model.statusWord(modelData.status) + (modelData.previous ? " (was " + modelData.previous + ")" : "") + " · reported " + Model.ago(modelData.at, root.now)
                onActivated: root.activateRow(rowIndex, 1)
              }
            }
          }

          PanelSeparator { foreground: root.foreground }

          MeetRow {
            width: parent.width
            rowIndex: root.siteRow
            glyph: "\u{f059f}"
            label: "DFW MTB Trail Hub"
            caption: "Maps, forecasts, closures and group rides"
            onActivated: root.activateRow(root.siteRow, 1)
          }

          MeetRow {
            width: parent.width
            rowIndex: root.optionsRow
            glyph: root.optionsOpen ? "\u{f0140}" : "\u{f0142}"
            label: "Filter options"
            caption: root.optionsOpen ? "" : "Bar: " + Model.barModeLabel(root.barMode) + " · alerts: " + Model.alertsLabel(root.alerts)
            onActivated: root.activateRow(root.optionsRow, 1)
          }

          MeetRow {
            visible: root.optionsOpen
            width: parent.width
            rowIndex: root.barModeRow
            glyph: "\u{f00a3}"
            label: "Show in bar: " + Model.barModeLabel(root.barMode)
            caption: "Click for the next choice, right-click for the one before"
            onActivated: function(direction) { root.activateRow(root.barModeRow, direction) }
          }

          MeetRow {
            visible: root.optionsOpen
            width: parent.width
            rowIndex: root.alertsRow
            glyph: root.alerts === "off" ? "\u{f009b}" : "\u{f009a}"
            label: "Alerts: " + Model.alertsLabel(root.alerts)
            caption: "A notification when a trail opens, closes or goes to caution"
            onActivated: function(direction) { root.activateRow(root.alertsRow, direction) }
          }

          MeetRow {
            visible: root.optionsOpen
            width: parent.width
            rowIndex: root.sortRow
            glyph: "\u{f04ba}"
            label: "Sort: " + Model.sortLabel(root.sortMode)
            caption: root.origin ? "Nearest, by name, or open first" : "Nearest needs your Weather location"
            onActivated: function(direction) { root.activateRow(root.sortRow, direction) }
          }

          MeetRow {
            visible: root.optionsOpen
            width: parent.width
            rowIndex: root.unitRow
            glyph: "\u{f046d}"
            label: "Units: " + (root.unit === "km" ? "kilometers" : "miles")
            caption: "Click to switch to " + (root.unit === "km" ? "miles" : "kilometers")
            onActivated: root.activateRow(root.unitRow, 1)
          }

          PanelSeparator { foreground: root.foreground }

          Text {
            width: parent.width
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            text: {
              var where = root.origin
                ? "Distances from " + (root.origin.name || "you") + (root.usingWeatherLocation ? " (your weather location)" : " (from your network)")
                : (root.usingWeatherLocation ? "Your Weather location has no coordinates; pick it from the Weather panel's search for distances." : "Location unknown; set one in the Weather panel for distances.")
              var when = root.fetchFailed && !root.feed.ok ? "Couldn't reach dfwmtbtrailhub.com. Middle-click to retry."
                : root.feed.generatedAt ? "Trail data from DFW MTB Trail Hub, updated " + Model.ago(root.feed.generatedAt, root.now)
                : "Trail data from DFW MTB Trail Hub"
              return where + "\n" + when + ". A closure posted at the trailhead overrides this."
            }
          }
        }
      }
    }
  }

  // A trail: its status icon in its color, name, status line, and a star you
  // can click to make it a favorite (or not).
  component TrailRow: MeetRow {
    id: trailRow
    property var trail: null
    glyph: trail ? root.statusGlyph(trail.shown) : ""
    glyphColor: trail ? root.statusColor(trail.shown) : root.foreground
    label: trail ? trail.name : ""
    caption: trail ? Model.caption(trail, root.unit, root.now) : ""
    star: trail ? (trail.favorite ? "\u{f04ce}" : "\u{f04d2}") : ""
    starLit: !!trail && trail.favorite
    onActivated: function(direction) { root.activateRow(rowIndex, direction) }
    onStarClicked: if (trail) root.toggleFavorite(trail.slug)
  }

  component MeetRow: CursorSurface {
    id: row
    property int rowIndex: 0
    property string glyph: ""
    property color glyphColor: root.foreground
    property string label: ""
    property string caption: ""
    property string star: ""
    property bool starLit: false
    signal activated(int direction)
    signal starClicked()

    hasCursor: root.cursorActive && root.rowIndex === rowIndex
    foreground: root.foreground
    implicitHeight: rowContent.implicitHeight + Style.spacing.rowPaddingX

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      acceptedButtons: Qt.LeftButton | Qt.RightButton
      onEntered: { root.cursorActive = true; root.rowIndex = row.rowIndex }
      onClicked: function(mouse) { row.activated(mouse.button === Qt.RightButton ? -1 : 1) }
    }

    RowLayout {
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(10)
      spacing: Style.space(8)

      Text {
        textFormat: Text.PlainText
        text: row.glyph
        color: row.glyphColor
        font.family: root.fontFamily
        font.pixelSize: Style.font.icon
        Layout.alignment: Qt.AlignVCenter
      }

      ColumnLayout {
        id: rowContent
        Layout.fillWidth: true
        spacing: Style.space(1)

        Text {
          Layout.fillWidth: true
          textFormat: Text.PlainText
          text: row.label
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          elide: Text.ElideRight
        }

        Text {
          Layout.fillWidth: true
          visible: row.caption !== ""
          textFormat: Text.PlainText
          text: row.caption
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }

      Text {
        visible: row.star !== ""
        textFormat: Text.PlainText
        text: row.star
        color: row.starLit ? Commons.Color.accent : root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.icon
        Layout.alignment: Qt.AlignVCenter

        MouseArea {
          anchors.fill: parent
          anchors.margins: -Style.space(6)
          cursorShape: Qt.PointingHandCursor
          onClicked: row.starClicked()
        }
      }
    }
  }
}
