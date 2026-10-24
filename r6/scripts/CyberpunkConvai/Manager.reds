module CyberpunkConvai

@if(ModuleExists("Codeware.UI"))
import Codeware.UI.*
@if(ModuleExists("Codeware.UI.TextInput"))
import Codeware.UI.TextInput.*

// Lua owns discovery, filtering and actions. Native code holds only one page.
public class ConvaiManagerRowData {
    public let key: String;
    public let label: String;
    public let note: String;
    public let selected: Bool;
}

public class ConvaiManagerViewData {
    public let rows: array<ref<ConvaiManagerRowData>>;
    public let tab: String;
    public let search: String;
    public let title: String;
    public let body: String;
    public let primaryAction: String;
    public let primaryLabel: String;
    public let primaryEnabled: Bool;
    public let secondaryAction: String;
    public let secondaryLabel: String;
    public let secondaryEnabled: Bool;
    public let page: String;
    public let previous: Bool;
    public let next: Bool;
    public let feedback: String;
    public let partyStatus: String;
}

// Keep native selection, clipboard and caret behavior. Queue keys while the
// Codeware glyph measurer is busy instead of losing fast search input.
// The old native manager window is built on Codeware's text input and popup. Without Codeware (or with one too old to have them)
// the window, its search box and the methods that open or close it are left out (each method has a stand-in below: closed, never
// opens), so these scripts still compile: a compile error would disable every redscript mod. The voice and subtitle switches
// and the data methods further down need no Codeware and always exist.
@if(ModuleExists("Codeware.UI.TextInput"))
public class ConvaiManagerSearchInput extends HubTextInput {
    private let m_pendingKeys: array<ref<inkKeyInputEvent>>;

    protected func CreateWidgets() -> Void {
        super.CreateWidgets();
        this.m_text.SetFontSize(28);
        this.m_root.SetHeight(62.0);
        this.m_wrapper.SetMargin(new inkMargin(16.0, 15.0, 16.0, 0.0));
    }

    protected func ProcessInputEvent(event: ref<inkKeyInputEvent>) -> Void {
        if this.m_measurer.IsMeasuring() || ArraySize(this.m_pendingKeys) > 0 {
            if ArraySize(this.m_pendingKeys) < 192 {
                ArrayPush(this.m_pendingKeys, event);
            };
            return;
        };
        super.ProcessInputEvent(event);
    }

    protected cb func OnHoldTick(anim: ref<inkAnimProxy>) {
        super.OnHoldTick(anim);
        if !this.m_measurer.IsMeasuring() && ArraySize(this.m_pendingKeys) > 0 {
            let event: ref<inkKeyInputEvent> = this.m_pendingKeys[0];
            ArrayErase(this.m_pendingKeys, 0);
            super.ProcessInputEvent(event);
        };
    }

    protected cb func OnFocusLost(event: ref<inkEvent>) {
        super.OnFocusLost(event);
    }

    public final func SetSearchText(value: String) -> Void {
        ArrayClear(this.m_pendingKeys);
        this.SetText(value);
        this.SetCaretPosition(UTF8StrLen(value));
    }

    public static func Create() -> ref<ConvaiManagerSearchInput> {
        let input: ref<ConvaiManagerSearchInput> = new ConvaiManagerSearchInput();
        input.CreateInstance();
        return input;
    }
}

@if(ModuleExists("Codeware.UI.TextInput"))
public class ConvaiManagerControl {
    public let root: wref<inkCanvas>;
    public let fill: wref<inkRectangle>;
    public let stripe: wref<inkRectangle>;
    public let label: wref<inkText>;
    public let note: wref<inkText>;
    public let action: String;
    public let enabled: Bool;
    public let selected: Bool;
    public let hovered: Bool;

    public final func Paint() -> Void {
        this.root.SetInteractive(this.enabled);
        this.root.SetSupportFocus(this.enabled);
        this.fill.SetOpacity(this.enabled ? (this.selected ? 0.20 : (this.hovered ? 0.13 : 0.045)) : 0.025);
        this.stripe.SetOpacity(this.selected ? 1.0 : (this.hovered && this.enabled ? 0.55 : 0.0));
        this.label.SetOpacity(this.enabled ? 1.0 : 0.32);
        this.note.SetOpacity(this.enabled ? 0.67 : 0.28);
    }
}

// Full native manager. Its root, input and eight list rows live for one popup;
// refreshes update text/state without recreating widgets or stealing text focus.
@if(ModuleExists("Codeware.UI.TextInput"))
public class ConvaiManagerPopup extends InGamePopup {
    private let m_player: wref<PlayerPuppet>;
    private let m_header: ref<InGamePopupHeader>;
    private let m_footer: ref<InGamePopupFooter>;
    private let m_search: ref<ConvaiManagerSearchInput>;
    private let m_controls: array<ref<ConvaiManagerControl>>;
    private let m_tabs: array<ref<ConvaiManagerControl>>;
    private let m_rows: array<ref<ConvaiManagerControl>>;
    private let m_primary: ref<ConvaiManagerControl>;
    private let m_secondary: ref<ConvaiManagerControl>;
    private let m_previous: ref<ConvaiManagerControl>;
    private let m_next: ref<ConvaiManagerControl>;
    private let m_detailPrevious: ref<ConvaiManagerControl>;
    private let m_detailNext: ref<ConvaiManagerControl>;
    private let m_detailPageLabel: wref<inkText>;
    private let m_detailPages: array<String>;
    private let m_detailPage: Int32;
    private let m_lastDetail: String;
    private let m_lastTitle: String;
    private let m_title: wref<inkText>;
    private let m_body: wref<inkText>;
    private let m_page: wref<inkText>;
    private let m_feedback: wref<inkText>;
    private let m_empty: wref<inkText>;
    private let m_keys: ref<CallbackSystemHandler>;
    private let m_closing: Bool;
    private let m_detached: Bool;
    private let m_updating: Bool;

    public static func Create(player: wref<PlayerPuppet>) -> ref<ConvaiManagerPopup> {
        let popup: ref<ConvaiManagerPopup> = new ConvaiManagerPopup();
        popup.m_player = player;
        popup.CreateInstance();
        return popup;
    }

    public func UseCursor() -> Bool {
        return true;
    }

    public final func IsClosing() -> Bool {
        return this.m_closing || this.m_detached;
    }

    public func Close() {
        if this.IsClosing() { return; };
        this.m_closing = true;
        this.StopKeys();
        // Open attaches asynchronously. A close requested before attachment
        // must be sent after OnShow, otherwise Codeware's Detach is a no-op.
        if this.IsInitialized() { super.Close(); };
    }

    protected cb func OnCreate() {
        super.OnCreate();
        this.m_container.SetSize(new Vector2(1760.0, 1040.0));
        this.m_container.SetMargin(new inkMargin(0.0, 0.0, 0.0, 0.0));

        let backdrop: ref<inkRectangle> = this.MakeBar(this.m_container, 36.0, 115.0, 1688.0, 817.0, n"MainColors.Fullscreen_PrimaryBackgroundDarkest", 0.91);
        backdrop.SetName(n"convaiManagerBackdrop");

        this.m_header = InGamePopupHeader.Create();
        this.m_header.SetTitle("COMPANION MANAGER");
        this.m_header.SetFluffLeft("NIGHT CITY");
        this.m_header.SetFluffRight("YOUR PARTY");
        this.m_header.Reparent(this);

        this.m_footer = InGamePopupFooter.Create();
        this.m_footer.SetFluffText("UP / DOWN: SELECT    LEFT / RIGHT: PAGE    TAB: SEARCH    ENTER: ACTION    F5: CLOSE");
        this.m_footer.Reparent(this);

        let canvas: ref<inkCanvas> = new inkCanvas();
        canvas.SetName(n"convaiManagerCanvas");
        canvas.SetSize(new Vector2(1608.0, 788.0));
        canvas.SetMargin(new inkMargin(76.0, 132.0, 0.0, 0.0));
        canvas.Reparent(this.m_container);

        ArrayPush(this.m_tabs, this.MakeControl(canvas, n"tabCharacters", "CHARACTERS", "", "tab:characters", 0.0, 0.0, 387.0, 52.0, false));
        ArrayPush(this.m_tabs, this.MakeControl(canvas, n"tabModels", "GAME MODELS", "", "tab:models", 407.0, 0.0, 387.0, 52.0, false));
        ArrayPush(this.m_tabs, this.MakeControl(canvas, n"tabParty", "YOUR PARTY", "", "tab:party", 814.0, 0.0, 387.0, 52.0, false));
        ArrayPush(this.m_tabs, this.MakeControl(canvas, n"tabSettings", "SETTINGS", "", "tab:settings", 1221.0, 0.0, 387.0, 52.0, false));

        this.MakeBar(canvas, 772.0, 88.0, 1.0, 686.0, n"MainColors.Blue", 0.20);
        this.m_search = ConvaiManagerSearchInput.Create();
        this.m_search.SetName(n"convaiManagerSearch");
        this.m_search.SetDefaultText("Search names, models or settings...");
        this.m_search.SetLetterCase(textLetterCase.OriginalCase);
        this.m_search.SetMaxLength(96);
        this.m_search.SetWidth(736.0);
        this.m_search.GetRootWidget().SetMargin(new inkMargin(0.0, 82.0, 0.0, 0.0));
        this.m_search.Reparent(canvas);
        this.m_search.RegisterToCallback(n"OnInput", this, n"OnSearchInput");

        let i: Int32 = 0;
        while i < 8 {
            ArrayPush(this.m_rows, this.MakeControl(canvas, StringToName("managerRow" + ToString(i)), "", "", "", 0.0, 165.0 + Cast<Float>(i) * 65.0, 736.0, 61.0, true));
            i += 1;
        };
        this.m_empty = this.MakeText(canvas, n"emptyList", "No entries yet.\nTry another search or tab.", 27, 24.0, 203.0, 676.0, 108.0, true);
        this.m_empty.SetOpacity(0.66);

        this.m_previous = this.MakeControl(canvas, n"previousPage", "<  PREVIOUS", "", "page:previous", 0.0, 708.0, 196.0, 48.0, false);
        this.m_next = this.MakeControl(canvas, n"nextPage", "NEXT  >", "", "page:next", 540.0, 708.0, 196.0, 48.0, false);
        this.m_page = this.MakeText(canvas, n"pageSummary", "", 22, 210.0, 718.0, 316.0, 35.0, false);
        this.m_page.SetHorizontalAlignment(textHorizontalAlignment.Center);

        this.MakeText(canvas, n"detailKicker", "SELECTED", 21, 814.0, 86.0, 794.0, 30.0, false).SetOpacity(0.6);
        this.m_title = this.MakeText(canvas, n"detailTitle", "", 40, 814.0, 120.0, 794.0, 108.0, true);
        this.MakeBar(canvas, 814.0, 237.0, 794.0, 2.0, n"MainColors.Red", 0.45);
        this.m_body = this.MakeText(canvas, n"detailBody", "", 27, 814.0, 260.0, 782.0, 266.0, true);
        this.m_detailPrevious = this.MakeControl(canvas, n"previousDetail", "<  TEXT", "", "_detail:previous", 814.0, 532.0, 176.0, 44.0, false);
        this.m_detailNext = this.MakeControl(canvas, n"nextDetail", "TEXT  >", "", "_detail:next", 1432.0, 532.0, 176.0, 44.0, false);
        this.m_detailPageLabel = this.MakeText(canvas, n"detailPage", "", 22, 1004.0, 541.0, 414.0, 32.0, false);
        this.m_detailPageLabel.SetHorizontalAlignment(textHorizontalAlignment.Center);
        this.m_primary = this.MakeControl(canvas, n"primaryAction", "", "", "", 814.0, 586.0, 794.0, 60.0, false);
        this.m_secondary = this.MakeControl(canvas, n"secondaryAction", "", "", "", 814.0, 658.0, 794.0, 54.0, false);
        this.m_feedback = this.MakeText(canvas, n"actionFeedback", "", 23, 814.0, 729.0, 794.0, 61.0, true);
        this.m_feedback.SetOpacity(0.88);
        this.UpdateView();
    }

    private final func MakeBar(parent: ref<inkCompoundWidget>, x: Float, y: Float, width: Float, height: Float, color: CName, opacity: Float) -> ref<inkRectangle> {
        let bar: ref<inkRectangle> = new inkRectangle();
        bar.SetSize(new Vector2(width, height));
        bar.SetMargin(new inkMargin(x, y, 0.0, 0.0));
        bar.SetStyle(r"base\\gameplay\\gui\\common\\main_colors.inkstyle");
        bar.BindProperty(n"tintColor", color);
        bar.SetOpacity(opacity);
        bar.SetInteractive(false);
        bar.Reparent(parent);
        return bar;
    }

    private final func MakeText(parent: ref<inkCompoundWidget>, name: CName, value: String, size: Int32, x: Float, y: Float, width: Float, height: Float, wrap: Bool) -> ref<inkText> {
        let label: ref<inkText> = new inkText();
        label.SetName(name);
        label.SetText(value);
        label.SetFontFamily("base\\gameplay\\gui\\fonts\\raj\\raj.inkfontfamily");
        label.SetFontStyle(n"Medium");
        label.SetFontSize(size);
        label.SetSize(new Vector2(width, height));
        label.SetMargin(new inkMargin(x, y, 0.0, 0.0));
        label.SetStyle(r"base\\gameplay\\gui\\common\\main_colors.inkstyle");
        label.BindProperty(n"tintColor", n"MainColors.Blue");
        label.SetWrapping(wrap);
        label.SetOverflowPolicy(textOverflowPolicy.DotsEnd);
        label.SetInteractive(false);
        label.Reparent(parent);
        return label;
    }

    private final func MakeControl(parent: ref<inkCompoundWidget>, name: CName, label: String, note: String, action: String, x: Float, y: Float, width: Float, height: Float, twoLines: Bool) -> ref<ConvaiManagerControl> {
        let control: ref<ConvaiManagerControl> = new ConvaiManagerControl();
        let root: ref<inkCanvas> = new inkCanvas();
        root.SetName(name);
        root.SetSize(new Vector2(width, height));
        root.SetMargin(new inkMargin(x, y, 0.0, 0.0));
        root.SetInteractive(true);
        root.SetSupportFocus(true);
        root.Reparent(parent);
        control.root = root;
        control.fill = this.MakeBar(root, 0.0, 0.0, width, height, n"MainColors.Blue", 0.045);
        control.stripe = this.MakeBar(root, 0.0, 0.0, 4.0, height, n"MainColors.Blue", 0.0);
        control.label = this.MakeText(root, n"label", label, twoLines ? 28 : 27, 18.0, twoLines ? 2.0 : 8.0, width - 36.0, 39.0, false);
        control.note = this.MakeText(root, n"note", note, 20, 18.0, 35.0, width - 36.0, 25.0, false);
        control.note.SetVisible(twoLines);
        control.action = action;
        control.enabled = true;
        root.RegisterToCallback(n"OnRelease", this, n"OnControlClick");
        root.RegisterToCallback(n"OnEnter", this, n"OnControlEnter");
        root.RegisterToCallback(n"OnLeave", this, n"OnControlLeave");
        root.RegisterToCallback(n"OnFocusReceived", this, n"OnControlFocus");
        root.RegisterToCallback(n"OnFocusLost", this, n"OnControlBlur");
        ArrayPush(this.m_controls, control);
        control.Paint();
        return control;
    }

    public final func UpdateView() -> Void {
        if !IsDefined(this.m_player) || this.IsClosing() || !IsDefined(this.m_search) { return; };
        this.m_updating = true;
        let data: ref<ConvaiManagerViewData> = this.m_player.ConvaiManagerView();
        let i: Int32 = 0;
        while i < ArraySize(this.m_tabs) {
            this.m_tabs[i].selected = Equals(this.m_tabs[i].action, "tab:" + data.tab);
            this.m_tabs[i].Paint();
            i += 1;
        };
        i = 0;
        while i < ArraySize(this.m_rows) {
            let visible: Bool = i < ArraySize(data.rows);
            this.m_rows[i].root.SetVisible(visible);
            if visible {
                let row: ref<ConvaiManagerRowData> = data.rows[i];
                this.m_rows[i].label.SetText(row.label);
                this.m_rows[i].note.SetText(row.note);
                this.m_rows[i].action = "select:" + row.key;
                this.m_rows[i].selected = row.selected;
                this.m_rows[i].enabled = StrLen(row.key) > 0;
                this.m_rows[i].Paint();
            };
            i += 1;
        };
        if NotEquals(this.m_search.GetText(), data.search) {
            this.m_search.SetSearchText(data.search);
        };
        this.m_title.SetText(data.title);
        let detail: String = data.body;
        if UTF8StrLen(data.feedback) > 140 {
            detail += "\n\nSTATUS\n" + data.feedback;
        };
        if NotEquals(detail, this.m_lastDetail) || NotEquals(data.title, this.m_lastTitle) {
            this.m_lastDetail = detail;
            this.m_lastTitle = data.title;
            this.m_detailPage = 0;
            this.BuildDetailPages(detail);
        };
        this.ShowDetailPage();
        this.m_primary.label.SetText(data.primaryLabel);
        this.m_primary.action = data.primaryAction;
        this.m_primary.enabled = data.primaryEnabled && StrLen(data.primaryAction) > 0;
        this.m_primary.selected = this.m_primary.enabled;
        this.m_primary.root.SetVisible(StrLen(data.primaryLabel) > 0);
        this.m_primary.Paint();
        this.m_secondary.label.SetText(data.secondaryLabel);
        this.m_secondary.action = data.secondaryAction;
        this.m_secondary.enabled = data.secondaryEnabled && StrLen(data.secondaryAction) > 0;
        this.m_secondary.root.SetVisible(StrLen(data.secondaryLabel) > 0);
        this.m_secondary.Paint();
        this.m_previous.enabled = data.previous;
        this.m_previous.Paint();
        this.m_next.enabled = data.next;
        this.m_next.Paint();
        this.m_page.SetText(data.page);
        this.m_feedback.SetText(UTF8StrLen(data.feedback) > 140 ? UTF8StrMid(data.feedback, 0, 94) + "... Read the full status in details." : data.feedback);
        this.m_empty.SetVisible(ArraySize(data.rows) == 0);
        this.m_header.SetFluffRight(StrLen(data.partyStatus) > 0 ? data.partyStatus : "YOUR PARTY");
        this.m_updating = false;
    }

    // A bounded text reader keeps long model IDs and status explanations
    // accessible without creating a growing widget tree or clipping the tail.
    private final func BuildDetailPages(value: String) -> Void {
        ArrayClear(this.m_detailPages);
        let length: Int32 = UTF8StrLen(value);
        let start: Int32 = 0;
        let cursor: Int32 = 0;
        let column: Int32 = 0;
        let lines: Int32 = 0;
        let lastSpace: Int32 = -1;
        while cursor < length {
            let char: String = UTF8StrMid(value, cursor, 1);
            if Equals(char, " ") || Equals(char, "\n") { lastSpace = cursor; };
            if Equals(char, "\n") {
                lines += 1;
                column = 0;
            } else {
                column += 1;
                if column >= 46 { lines += 1; column = 0; };
            };
            cursor += 1;
            if lines >= 7 || cursor - start >= 320 {
                let cut: Int32 = lastSpace > start ? lastSpace + 1 : cursor;
                ArrayPush(this.m_detailPages, UTF8StrMid(value, start, cut - start));
                start = cut;
                cursor = cut;
                column = 0;
                lines = 0;
                lastSpace = -1;
            };
        };
        if start < length { ArrayPush(this.m_detailPages, UTF8StrMid(value, start, length - start)); };
        if ArraySize(this.m_detailPages) == 0 { ArrayPush(this.m_detailPages, ""); };
    }

    private final func ShowDetailPage() -> Void {
        let count: Int32 = ArraySize(this.m_detailPages);
        if count == 0 { this.BuildDetailPages(""); count = 1; };
        if this.m_detailPage >= count { this.m_detailPage = count - 1; };
        this.m_body.SetText(this.m_detailPages[this.m_detailPage]);
        this.m_detailPrevious.root.SetVisible(count > 1);
        this.m_detailNext.root.SetVisible(count > 1);
        this.m_detailPageLabel.SetVisible(count > 1);
        this.m_detailPrevious.enabled = this.m_detailPage > 0;
        this.m_detailNext.enabled = this.m_detailPage < count - 1;
        this.m_detailPrevious.Paint();
        this.m_detailNext.Paint();
        this.m_detailPageLabel.SetText("DETAILS  " + ToString(this.m_detailPage + 1) + " / " + ToString(count));
    }

    private final func FindControl(widget: wref<inkWidget>) -> ref<ConvaiManagerControl> {
        let i: Int32 = 0;
        while i < ArraySize(this.m_controls) {
            if this.m_controls[i].root == widget { return this.m_controls[i]; };
            i += 1;
        };
        return null;
    }

    protected cb func OnControlClick(evt: ref<inkPointerEvent>) -> Bool {
        if !evt.IsAction(n"click") || evt.IsHandled() || this.IsClosing() { return false; };
        let control: ref<ConvaiManagerControl> = this.FindControl(evt.GetCurrentTarget());
        if !IsDefined(control) || !control.enabled { return false; };
        this.Dispatch(control.action);
        evt.Handle();
        return true;
    }

    protected cb func OnControlEnter(evt: ref<inkPointerEvent>) -> Bool {
        let control: ref<ConvaiManagerControl> = this.FindControl(evt.GetCurrentTarget());
        if IsDefined(control) { control.hovered = true; control.Paint(); };
        return false;
    }

    protected cb func OnControlLeave(evt: ref<inkPointerEvent>) -> Bool {
        let control: ref<ConvaiManagerControl> = this.FindControl(evt.GetCurrentTarget());
        if IsDefined(control) { control.hovered = false; control.Paint(); };
        return false;
    }

    protected cb func OnControlFocus(evt: ref<inkEvent>) -> Bool {
        let control: ref<ConvaiManagerControl> = this.FindControl(evt.GetCurrentTarget());
        if IsDefined(control) { control.hovered = true; control.Paint(); };
        return false;
    }

    protected cb func OnControlBlur(evt: ref<inkEvent>) -> Bool {
        let control: ref<ConvaiManagerControl> = this.FindControl(evt.GetCurrentTarget());
        if IsDefined(control) { control.hovered = false; control.Paint(); };
        return false;
    }

    protected cb func OnSearchInput(widget: wref<inkWidget>) -> Bool {
        if this.m_updating || this.IsClosing() || !IsDefined(this.m_player) { return false; };
        this.m_player.ConvaiManagerRequestSearch(this.m_search.GetText());
        this.UpdateView();
        return true;
    }

    private final func Dispatch(action: String) -> Void {
        if !IsDefined(this.m_player) || this.IsClosing() || StrLen(action) == 0 { return; };
        if Equals(action, "_detail:previous") || Equals(action, "_detail:next") {
            if Equals(action, "_detail:previous") && this.m_detailPage > 0 { this.m_detailPage -= 1; };
            if Equals(action, "_detail:next") && this.m_detailPage < ArraySize(this.m_detailPages) - 1 { this.m_detailPage += 1; };
            this.ShowDetailPage();
            return;
        };
        let data: ref<ConvaiManagerViewData> = this.m_player.ConvaiManagerView();
        let i: Int32 = 0;
        while i < ArraySize(this.m_tabs) {
            if Equals(action, this.m_tabs[i].action) {
                this.m_player.ConvaiManagerRequestTab(this.TabAt(i));
                this.UpdateView();
                return;
            };
            i += 1;
        };
        i = 0;
        while i < ArraySize(data.rows) {
            if Equals(action, "select:" + data.rows[i].key) {
                let j: Int32 = 0;
                while j < ArraySize(data.rows) {
                    data.rows[j].selected = j == i;
                    j += 1;
                };
                data.primaryEnabled = false;
                data.secondaryEnabled = false;
                this.m_player.ConvaiManagerQueueRequest(action);
                this.UpdateView();
                return;
            };
            i += 1;
        };
        if Equals(action, "page:previous") || Equals(action, "page:next") {
            if (Equals(action, "page:previous") && !data.previous) || (Equals(action, "page:next") && !data.next) { return; };
            this.m_player.ConvaiManagerAwaitPage();
        } else {
            data.primaryEnabled = false;
            data.secondaryEnabled = false;
            data.feedback = "Request queued...";
        };
        this.m_player.ConvaiManagerQueueRequest(action);
        this.UpdateView();
    }

    private final func TabAt(index: Int32) -> String {
        switch index {
            case 1: return "models";
            case 2: return "party";
            case 3: return "settings";
        };
        return "characters";
    }

    private final func MoveSelection(direction: Int32) -> Void {
        let data: ref<ConvaiManagerViewData> = this.m_player.ConvaiManagerView();
        let count: Int32 = ArraySize(data.rows);
        if count == 0 { return; };
        let selected: Int32 = -1;
        let i: Int32 = 0;
        while i < count {
            if data.rows[i].selected { selected = i; };
            i += 1;
        };
        let target: Int32 = selected < 0 ? (direction > 0 ? 0 : count - 1) : selected + direction;
        if target < 0 { target = count - 1; };
        if target >= count { target = 0; };
        this.GetGameController().RequestSetFocus(this.m_rows[target].root);
        this.Dispatch("select:" + data.rows[target].key);
    }

    private final func MoveTab(direction: Int32) -> Void {
        let data: ref<ConvaiManagerViewData> = this.m_player.ConvaiManagerView();
        let index: Int32 = 0;
        let i: Int32 = 0;
        while i < 4 {
            if Equals(this.TabAt(i), data.tab) { index = i; };
            i += 1;
        };
        index += direction;
        if index < 0 { index = 3; };
        if index > 3 { index = 0; };
        this.Dispatch("tab:" + this.TabAt(index));
    }

    protected cb func OnManagerKey(evt: ref<KeyInputEvent>) -> Void {
        if this.IsClosing() || !this.IsTopPopup() || !IsDefined(this.m_player) || evt.IsAltDown() { return; };
        if Equals(evt.GetKey(), EInputKey.IK_Tab) {
            if this.m_search.IsFocused() {
                this.GetGameController().RequestSetFocus(null);
                this.MoveSelection(1);
            } else {
                this.GetGameController().RequestSetFocus(this.m_search.GetRootWidget());
            };
            return;
        };
        if this.m_search.IsFocused() { return; };
        switch evt.GetKey() {
            case EInputKey.IK_Up: this.MoveSelection(-1); break;
            case EInputKey.IK_Down: this.MoveSelection(1); break;
            case EInputKey.IK_Left:
                if evt.IsControlDown() { this.MoveTab(-1); } else { this.Dispatch("page:previous"); };
                break;
            case EInputKey.IK_Right:
                if evt.IsControlDown() { this.MoveTab(1); } else { this.Dispatch("page:next"); };
                break;
            case EInputKey.IK_Enter:
                if this.m_primary.enabled { this.Dispatch(this.m_primary.action); };
                break;
        };
    }

    protected cb func OnShow() {
        super.OnShow();
        if this.m_closing {
            super.Close();
            return;
        };
        this.m_keys = ConvaiCallbackSystem()
            .RegisterCallback(n"Input/Key", this, n"OnManagerKey")
            .AddTarget(InputTarget.Key(EInputKey.IK_Up, EInputAction.IACT_Press))
            .AddTarget(InputTarget.Key(EInputKey.IK_Down, EInputAction.IACT_Press))
            .AddTarget(InputTarget.Key(EInputKey.IK_Left, EInputAction.IACT_Press))
            .AddTarget(InputTarget.Key(EInputKey.IK_Right, EInputAction.IACT_Press))
            .AddTarget(InputTarget.Key(EInputKey.IK_Tab, EInputAction.IACT_Press))
            .AddTarget(InputTarget.Key(EInputKey.IK_Enter, EInputAction.IACT_Press));
    }

    protected cb func OnShown() {
        if !this.IsClosing() {
            this.GetGameController().RequestSetFocus(this.m_search.GetRootWidget());
        };
    }

    private final func StopKeys() -> Void {
        if IsDefined(this.m_keys) {
            this.m_keys.Unregister();
            this.m_keys = null;
        };
    }

    protected cb func OnDetach() {
        if this.m_detached { return; };
        this.m_detached = true;
        this.m_closing = true;
        this.StopKeys();
        if IsDefined(this.m_transitionAnimProxy) { this.m_transitionAnimProxy.Stop(); };
        // Base detachment runs OnHide: restore context, time dilation and blur.
        super.OnDetach();
        if IsDefined(this.m_player) { this.m_player.ConvaiManagerDidClose(this); };
    }

    protected cb func OnHidden() {
        if IsDefined(this.m_player) { this.m_player.ConvaiManagerDidClose(this); };
        super.OnHidden();
    }
}

@addField(PlayerPuppet)
private let m_convaiManagerView: ref<ConvaiManagerViewData>;

@addField(PlayerPuppet)
private let m_convaiManagerRequests: array<String>;

@addMethod(PlayerPuppet)
public final func ConvaiManagerView() -> ref<ConvaiManagerViewData> {
    this.ConvaiManagerEnsure();
    return this.m_convaiManagerView;
}

@addMethod(PlayerPuppet)
public final func ConvaiManagerClearRows() -> Void {
    this.ConvaiManagerEnsure();
    ArrayClear(this.m_convaiManagerView.rows);
}

@addMethod(PlayerPuppet)
public final func ConvaiManagerAddRow(key: String, label: String, note: String, selected: Bool) -> Void {
    this.ConvaiManagerEnsure();
    if ArraySize(this.m_convaiManagerView.rows) >= 8 || StrLen(key) == 0 { return; };
    let row: ref<ConvaiManagerRowData> = new ConvaiManagerRowData();
    row.key = key;
    row.label = label;
    row.note = note;
    row.selected = selected;
    ArrayPush(this.m_convaiManagerView.rows, row);
}

@addMethod(PlayerPuppet)
public final func ConvaiManagerSetDetail(title: String, body: String, primaryAction: String, primaryLabel: String, primaryEnabled: Bool, secondaryAction: String, secondaryLabel: String, secondaryEnabled: Bool) -> Void {
    this.ConvaiManagerEnsure();
    let data: ref<ConvaiManagerViewData> = this.m_convaiManagerView;
    data.title = title;
    data.body = body;
    data.primaryAction = primaryAction;
    data.primaryLabel = primaryLabel;
    data.primaryEnabled = primaryEnabled;
    data.secondaryAction = secondaryAction;
    data.secondaryLabel = secondaryLabel;
    data.secondaryEnabled = secondaryEnabled;
}

@addMethod(PlayerPuppet)
public final func ConvaiManagerSetPage(text: String, previous: Bool, next: Bool) -> Void {
    this.ConvaiManagerEnsure();
    this.m_convaiManagerView.page = text;
    this.m_convaiManagerView.previous = previous;
    this.m_convaiManagerView.next = next;
}

@addMethod(PlayerPuppet)
public final func ConvaiManagerSetTab(tab: String) -> Void {
    this.ConvaiManagerEnsure();
    if Equals(tab, "characters") || Equals(tab, "models") || Equals(tab, "party") || Equals(tab, "settings") {
        this.m_convaiManagerView.tab = tab;
    };
}

@addMethod(PlayerPuppet)
public final func ConvaiManagerSetSearch(text: String) -> Void {
    this.ConvaiManagerEnsure();
    this.m_convaiManagerView.search = text;
}

@addMethod(PlayerPuppet)
public final func ConvaiManagerSetFeedback(text: String) -> Void {
    this.ConvaiManagerEnsure();
    this.m_convaiManagerView.feedback = text;
}

@addMethod(PlayerPuppet)
public final func ConvaiManagerSetPartyStatus(text: String) -> Void {
    this.ConvaiManagerEnsure();
    this.m_convaiManagerView.partyStatus = text;
}

@if(ModuleExists("Codeware.UI.TextInput"))
@addMethod(PlayerPuppet)
public final func ConvaiManagerRefresh() -> Void {
    if IsDefined(this.m_convaiManagerPopup) {
        this.m_convaiManagerPopup.UpdateView();
    };
}

@addMethod(PlayerPuppet)
public final func ConvaiManagerTakeRequest() -> String {
    if ArraySize(this.m_convaiManagerRequests) == 0 { return ""; };
    let request: String = this.m_convaiManagerRequests[0];
    ArrayErase(this.m_convaiManagerRequests, 0);
    return request;
}

@addMethod(PlayerPuppet)
public final func ConvaiManagerQueueRequest(request: String) -> Void {
    if StrLen(request) == 0 { return; };
    let count: Int32 = ArraySize(this.m_convaiManagerRequests);
    if count > 0 && Equals(this.m_convaiManagerRequests[count - 1], request) { return; };
    if count >= 64 {
        this.ConvaiManagerSetFeedback("Please wait for the current requests to finish.");
        return;
    };
    ArrayPush(this.m_convaiManagerRequests, request);
}

@addMethod(PlayerPuppet)
public final func ConvaiManagerAwaitPage() -> Void {
    this.ConvaiManagerEnsure();
    ArrayClear(this.m_convaiManagerView.rows);
    this.m_convaiManagerView.previous = false;
    this.m_convaiManagerView.next = false;
    this.m_convaiManagerView.primaryEnabled = false;
    this.m_convaiManagerView.secondaryEnabled = false;
    this.m_convaiManagerView.title = "Updating selection";
    this.m_convaiManagerView.body = "The list will refresh in a moment.";
    this.m_convaiManagerView.feedback = "";
}

@addMethod(PlayerPuppet)
public final func ConvaiManagerRequestTab(tab: String) -> Void {
    this.ConvaiManagerSetTab(tab);
    this.m_convaiManagerView.search = "";
    this.ConvaiManagerAwaitPage();
    this.ConvaiManagerQueueRequest("tab:" + this.m_convaiManagerView.tab);
    this.ConvaiManagerQueueRequest("search:");
}

@addMethod(PlayerPuppet)
public final func ConvaiManagerRequestSearch(text: String) -> Void {
    this.ConvaiManagerEnsure();
    let previous: String = this.m_convaiManagerView.search;
    if Equals(previous, text) { return; };
    this.m_convaiManagerView.search = text;
    this.ConvaiManagerAwaitPage();
    let last: Int32 = ArraySize(this.m_convaiManagerRequests) - 1;
    if last >= 0 && Equals(this.m_convaiManagerRequests[last], "search:" + previous) {
        this.m_convaiManagerRequests[last] = "search:" + text;
    } else {
        this.ConvaiManagerQueueRequest("search:" + text);
    };
}

@if(ModuleExists("Codeware.UI.TextInput"))
@addMethod(PlayerPuppet)
public final func ConvaiManagerDidClose(popup: ref<ConvaiManagerPopup>) -> Void {
    // A late animation callback from an old screen cannot clear a newer one.
    if this.m_convaiManagerPopup == popup {
        this.m_convaiManagerPopup = null;
        ArrayClear(this.m_convaiManagerRequests);
    };
}

// Legacy configuration API retained for existing CET callers.
@if(ModuleExists("Codeware.UI.TextInput"))
@addField(PlayerPuppet)
private let m_convaiManagerPopup: wref<ConvaiManagerPopup>;

@addField(PlayerPuppet)
private let m_convaiManagerInitialized: Bool;

@addField(PlayerPuppet)
private let m_convaiManagerEnabled: array<Bool>;

@addField(PlayerPuppet)
private let m_convaiManagerSelected: Int32;

@addField(PlayerPuppet)
private let m_convaiManagerVoice: Bool;

@addField(PlayerPuppet)
private let m_convaiManagerSubtitles: Bool;

@addField(PlayerPuppet)
private let m_convaiManagerRevision: Int32;

@addMethod(PlayerPuppet)
private final func ConvaiManagerEnsure() -> Void {
    if !IsDefined(this.m_convaiManagerView) {
        this.m_convaiManagerView = new ConvaiManagerViewData();
        this.m_convaiManagerView.tab = "characters";
        this.m_convaiManagerView.title = "Choose a character";
        this.m_convaiManagerView.body = "Browse your characters, discover a game model, or manage your current party.";
        this.m_convaiManagerView.page = "Loading...";
    };
    if this.m_convaiManagerInitialized {
        return;
    };
    this.m_convaiManagerInitialized = true;
    let i: Int32 = 0;
    while i < 6 {
        ArrayPush(this.m_convaiManagerEnabled, true);
        i += 1;
    };
    this.m_convaiManagerVoice = true;
    this.m_convaiManagerSubtitles = true;
}

@if(ModuleExists("Codeware.UI.TextInput"))
@addMethod(PlayerPuppet)
public final func ConvaiOpenManager() -> Bool {
    this.ConvaiManagerEnsure();
    if GameInstance.GetBlackboardSystem(this.GetGame())
        .Get(GetAllBlackboardDefs().UI_System)
        .GetBool(GetAllBlackboardDefs().UI_System.IsInMenu) {
        return false;
    };
    if IsDefined(this.m_convaiManagerPopup) {
        return false;
    };
    let layer = GameInstance.GetInkSystem().GetLayer(n"inkHUDLayer");
    if !IsDefined(layer) || !IsDefined(layer.GetGameController()) {
        return false;
    };
    ArrayClear(this.m_convaiManagerRequests);
    this.ConvaiManagerQueueRequest("tab:" + this.m_convaiManagerView.tab);
    this.ConvaiManagerQueueRequest("search:" + this.m_convaiManagerView.search);
    let popup: ref<ConvaiManagerPopup> = ConvaiManagerPopup.Create(this);
    this.m_convaiManagerPopup = popup;
    popup.Open(layer.GetGameController() as inkGameController);
    return true;
}

@if(ModuleExists("Codeware.UI.TextInput"))
@addMethod(PlayerPuppet)
public final func ConvaiCloseManager() -> Bool {
    if !IsDefined(this.m_convaiManagerPopup) {
        return false;
    };
    let popup: ref<ConvaiManagerPopup> = this.m_convaiManagerPopup;
    popup.Close();
    return true;
}

@if(ModuleExists("Codeware.UI.TextInput"))
@addMethod(PlayerPuppet)
public final func ConvaiManagerIsOpen() -> Bool {
    return IsDefined(this.m_convaiManagerPopup) && !this.m_convaiManagerPopup.IsClosing();
}

@addMethod(PlayerPuppet)
public final func ConvaiManagerName(index: Int32) -> String {
    switch index {
        case 0: return "VIKTOR VEKTOR";
        case 1: return "MISTY OLSZEWSKI";
        case 2: return "JUDY ALVAREZ";
        case 3: return "PANAM PALMER";
        case 4: return "NIGHT CITY RESIDENT / M";
        case 5: return "NIGHT CITY RESIDENT / F";
    };
    return "UNKNOWN";
}

@addMethod(PlayerPuppet)
public final func ConvaiManagerSelected() -> Int32 {
    this.ConvaiManagerEnsure();
    return this.m_convaiManagerSelected;
}

@addMethod(PlayerPuppet)
public final func ConvaiManagerSelect(index: Int32) -> Void {
    this.ConvaiManagerEnsure();
    if index >= 0 && index < 6 {
        this.m_convaiManagerSelected = index;
        this.m_convaiManagerRevision += 1;
    };
}

@addMethod(PlayerPuppet)
public final func ConvaiManagerEnabled(index: Int32) -> Bool {
    this.ConvaiManagerEnsure();
    return index >= 0 && index < ArraySize(this.m_convaiManagerEnabled) && this.m_convaiManagerEnabled[index];
}

@addMethod(PlayerPuppet)
public final func ConvaiManagerSetEnabled(index: Int32, enabled: Bool) -> Void {
    this.ConvaiManagerEnsure();
    if index >= 0 && index < ArraySize(this.m_convaiManagerEnabled) {
        this.m_convaiManagerEnabled[index] = enabled;
        this.m_convaiManagerRevision += 1;
    };
}

@addMethod(PlayerPuppet)
public final func ConvaiManagerVoice() -> Bool {
    this.ConvaiManagerEnsure();
    return this.m_convaiManagerVoice;
}

@addMethod(PlayerPuppet)
public final func ConvaiManagerSetVoice(enabled: Bool) -> Void {
    this.ConvaiManagerEnsure();
    this.m_convaiManagerVoice = enabled;
    this.m_convaiManagerRevision += 1;
}

@addMethod(PlayerPuppet)
public final func ConvaiManagerSubtitles() -> Bool {
    this.ConvaiManagerEnsure();
    return this.m_convaiManagerSubtitles;
}

@addMethod(PlayerPuppet)
public final func ConvaiManagerSetSubtitles(enabled: Bool) -> Void {
    this.ConvaiManagerEnsure();
    this.m_convaiManagerSubtitles = enabled;
    this.m_convaiManagerRevision += 1;
}

@addMethod(PlayerPuppet)
public final func ConvaiManagerRevision() -> Int32 {
    this.ConvaiManagerEnsure();
    return this.m_convaiManagerRevision;
}

// Stand-ins without the window: nothing is open and nothing can be opened.
@if(!ModuleExists("Codeware.UI.TextInput"))
@addMethod(PlayerPuppet)
public final func ConvaiManagerRefresh() -> Void {
}

@if(!ModuleExists("Codeware.UI.TextInput"))
@addMethod(PlayerPuppet)
public final func ConvaiOpenManager() -> Bool {
    return false;
}

@if(!ModuleExists("Codeware.UI.TextInput"))
@addMethod(PlayerPuppet)
public final func ConvaiCloseManager() -> Bool {
    return false;
}

@if(!ModuleExists("Codeware.UI.TextInput"))
@addMethod(PlayerPuppet)
public final func ConvaiManagerIsOpen() -> Bool {
    return false;
}
