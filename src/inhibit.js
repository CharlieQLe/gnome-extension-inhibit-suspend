'use strict';

const { Gio, GObject } = imports.gi;
const QuickSettings = imports.ui.quickSettings;
const QuickSettingsMenu = imports.ui.main.panel.statusArea.quickSettings;
const MainLoop = imports.mainloop;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const FORCE_ENABLE_APP_ID = 'inhibit-extension-force';
const FULLSCREEN_APP_ID = 'inhibit-extension-fullscreen';

const DBusSessionManagerXml = `
<node>
  <interface name="org.gnome.SessionManager">
    <method name="Inhibit">
        <arg type="s" direction="in" />
        <arg type="u" direction="in" />
        <arg type="s" direction="in" />
        <arg type="u" direction="in" />
        <arg type="u" direction="out" />
    </method>
    <method name="Uninhibit">
        <arg type="u" direction="in" />
    </method>
       <method name="GetInhibitors">
           <arg type="ao" direction="out" />
       </method>
    <signal name="InhibitorAdded">
        <arg type="o" direction="out" />
    </signal>
    <signal name="InhibitorRemoved">
        <arg type="o" direction="out" />
    </signal>
  </interface>
</node>`;
const DBusSessionManagerProxy = Gio.DBusProxy.makeProxyWrapper(DBusSessionManagerXml);

const DBusSessionManagerInhibitorXml = `
<node>
  <interface name="org.gnome.SessionManager.Inhibitor">
    <method name="GetAppId">
        <arg type="s" direction="out" />
    </method>
  </interface>
</node>`;
const DBusSessionManagerInhibitorProxy = Gio.DBusProxy.makeProxyWrapper(DBusSessionManagerInhibitorXml);

class InhibitData {
    constructor(appId, cookie, object) {
        this.appId = appId;
        this.cookie = cookie;
        this.object = object;
    }
}

class InhibitSuspendToggle extends QuickSettings.QuickToggle {
    static {
        GObject.registerClass(this);
    }
    
    _init() {
        super._init({
            label: 'Inhibit Suspend',
            toggleMode: true,
        });
        this.gicon = Gio.icon_new_for_string(`${Me.path}/icons/inhibit-symbolic.svg`);

        // DBus
        this._sessionManager = new DBusSessionManagerProxy(Gio.DBus.session, 'org.gnome.SessionManager', '/org/gnome/SessionManager');
        this._inhibitorAddedSignal = this._sessionManager.connectSignal('InhibitorAdded', this._inhibitorAdded.bind(this));
        this._inhibitorRemovedSignal = this._sessionManager.connectSignal('InhibitorRemoved', this._inhibitorRemoved.bind(this));
        
        // Data
        this._state = false;
        this._last_data = new InhibitData('', '', null);
        this._data = [];

        // Screen
        this._fullscreenId = global.display.connect('in-fullscreen-changed', this._handleFullscreen.bind(this));

        // Signals
        this.connect('clicked', () => this._updateState());
        this.connect('destroy', () => {
            if (this._fullscreenId) global.display.disconnect(this._fullscreenId);
        });
        this._onEnableInhibit = [];
        this._onDisableInhibit = [];
    }

    connectEnableInhibitSignal(func) {
        this._connectSignal(func, this._onEnableInhibit);
    }

    disconnectEnableInhibitSignal(func) {
        this._disconnectSignal(func, this._onEnableInhibit);
    }

    connectDisableInhibitSignal(func) {
        this._connectSignal(func, this._onDisableInhibit);
    }

    disconnectDisableInhibitSignal(func) {
        this._disconnectSignal(func, this._onDisableInhibit);
    }

    _connectSignal(func, list) {
        const index = list.indexOf(func);
        if (index === -1) list.push(func);
    }

    _disconnectSignal(func, list) {
        const index = list.indexOf(func);
        if (index !== -1) list.splice(func, 1);
    }
    
    _invokeSignal(list) {
        list.forEach(func => func());
    }

    _isFullscreen() {
        const numOfMonitors = global.display.get_n_monitors();
        for (let i = 0; i < numOfMonitors; i++) {
            if (global.display.get_monitor_in_fullscreen(i)) return true;
        }
        return false;
    }

    _handleFullscreen() {
        const includeFullscreen = () => this._data.reduce((includes, element) => includes || element.appId === FULLSCREEN_APP_ID, false);

        MainLoop.timeout_add_seconds(2, () => {
            if (this._isFullscreen() && !includeFullscreen()) this._addInhibitor(FULLSCREEN_APP_ID);
        });

        if (!this._isFullscreen() && includeFullscreen()) this._removeInhibitor(FULLSCREEN_APP_ID);
    }

    _updateState() {
        this.checked = false;
        if (this._state) this._data.forEach(data => this._removeInhibitor(data.appId));
        else this._addInhibitor(FORCE_ENABLE_APP_ID);
    }

    _addInhibitor(appId) {
        this._sessionManager.InhibitRemote(appId, 0, 'Inhibit by %s'.format("Inhibit Suspend Extension"), 12, cookie => {
            this._last_data.appId = appId;
            this._last_data.cookie = cookie;
        });
    }

    _removeInhibitor(appId) {
        const index = this._data.reduce((idx, element, i) => (idx === -1 && element.appId === appId) ? i : idx, -1);
        if (index !== -1) this._sessionManager.UninhibitRemote(this._data[index].cookie);
    }

    _inhibitorAdded(proxy, sender, [object]) {
        this._sessionManager.GetInhibitorsRemote(([inhibitors]) => {
            for (let i of inhibitors) {
                const inhibitor = new DBusSessionManagerInhibitorProxy(Gio.DBus.session, 'org.gnome.SessionManager', i);
                inhibitor.GetAppIdRemote(appId => {
                    appId = String(appId);
                    if (appId !== '' && appId === this._last_data.appId) {
                        this._data.push(new InhibitData(this._last_data.appId, this._last_data.cookie, object));
                        this._last_data.appId = '';
                        this._last_data.cookie = '';
                        if (this._state === false) {
                            this._state = true;
                            this.checked = true;
                            this._invokeSignal(this._onEnableInhibit);
                        }
                    }
                });
            }
        });
    }

    _inhibitorRemoved(proxy, sender, [object]) {
        const index = this._data.reduce((idx, element, i) => (idx === -1 && element.object === object) ? i : idx, -1);
        if (index !== -1) {
            this._data.splice(index, 1);
            if (this._data.length === 0) {
                this._state = false;
                this.checked = false;
                this._invokeSignal(this._onDisableInhibit);
            }
        }
    }
}

var InhibitSuspendIndicator = class InhibitSuspendIndicator extends QuickSettings.SystemIndicator {
    static {
        GObject.registerClass(this);
    }

    _init() {
        super._init();

        // Create indicator
        this._indicator = this._addIndicator();
        this._indicator.gicon = Gio.icon_new_for_string(`${Me.path}/icons/inhibit-symbolic.svg`);
        this.visible = false;
        
        // Handle the toggle
        const toggle = new InhibitSuspendToggle();
        toggle.connectEnableInhibitSignal(() => this.visible = true);
        toggle.connectDisableInhibitSignal(() => this.visible = false);
        this.quickSettingsItems.push(toggle);

        // Destroy
        this.connect('destroy', () => this.quickSettingsItems.forEach(item => item.destroy()));
        
        // Add indicator and toggle
        QuickSettingsMenu._indicators.insert_child_at_index(this, 0);
        QuickSettingsMenu._addItems(this.quickSettingsItems);
    }
}