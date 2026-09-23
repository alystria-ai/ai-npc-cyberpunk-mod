module CyberpunkConvai

import Codeware.UI.*

// The manager owns a native ink screen. MCM is not needed to open or render it.
public class ConvaiManagerPopup extends InGamePopup {
    private let m_header: ref<InGamePopupHeader>;
    private let m_footer: ref<InGamePopupFooter>;
    private let m_player: wref<PlayerPuppet>;
    private let m_rows: array<wref<inkText>>;
    private let m_status: wref<inkText>;
    private let m_enable: wref<inkText>;
    private let m_voice: wref<inkText>;
    private let m_subtitles: wref<inkText>;

    public static func Create(player: wref<PlayerPuppet>) -> ref<ConvaiManagerPopup> {
        let popup: ref<ConvaiManagerPopup> = new ConvaiManagerPopup();
        popup.m_player = player;
        popup.CreateInstance();
        return popup;
    }

    public func UseCursor() -> Bool {
        return true;
    }

    protected cb func OnCreate() {
        super.OnCreate();
        this.m_container.SetSize(new Vector2(1800.0, 1040.0));

        this.m_header = InGamePopupHeader.Create();
        this.m_header.SetTitle("COMPANION MANAGER");
        this.m_header.SetFluffRight("NIGHT CITY // CONVAI");
        this.m_header.Reparent(this);

        this.m_footer = InGamePopupFooter.Create();
        this.m_footer.SetFluffText("SELECT A CHARACTER / CONFIGURE CONVERSATION");
        this.m_footer.Reparent(this);

        let canvas: ref<inkCanvas> = new inkCanvas();
        canvas.SetName(n"convaiManagerCanvas");
        canvas.SetSize(new Vector2(1680.0, 840.0));
        canvas.SetMargin(new inkMargin(60.0, 125.0, 60.0, 55.0));
        canvas.Reparent(this.m_container);

        this.MakeText(canvas, n"rosterHeading", "CHARACTERS", 32, 24.0, 0.0, 580.0, false);
        this.MakeText(canvas, n"detailHeading", "CONVERSATION", 32, 720.0, 0.0, 840.0, false);
        this.AddRow(canvas, 0, "VIKTOR VEKTOR");
        this.AddRow(canvas, 1, "MISTY OLSZEWSKI");
        this.AddRow(canvas, 2, "JUDY ALVAREZ");
        this.AddRow(canvas, 3, "PANAM PALMER");
        this.AddRow(canvas, 4, "NIGHT CITY RESIDENT / M");
        this.AddRow(canvas, 5, "NIGHT CITY RESIDENT / F");

        this.m_status = this.MakeText(canvas, n"selection", "", 38, 720.0, 110.0, 900.0, false);
        this.m_enable = this.MakeText(canvas, n"enable", "", 35, 720.0, 235.0, 900.0, true);
        this.m_voice = this.MakeText(canvas, n"voice", "", 35, 720.0, 340.0, 900.0, true);
        this.m_subtitles = this.MakeText(canvas, n"subtitles", "", 35, 720.0, 445.0, 900.0, true);
        this.MakeText(canvas, n"help", "Click a character to manage it. Escape closes this screen.", 28, 720.0, 650.0, 900.0, false);
        this.UpdateView();
    }

    private final func AddRow(parent: ref<inkCanvas>, index: Int32, label: String) -> Void {
        let row: ref<inkText> = this.MakeText(parent, StringToName("companion_" + ToString(index)), label, 36, 24.0, 100.0 + Cast<Float>(index) * 112.0, 630.0, true);
        ArrayPush(this.m_rows, row);
    }

    private final func MakeText(parent: ref<inkCanvas>, name: CName, value: String, size: Int32, x: Float, y: Float, width: Float, clickable: Bool) -> ref<inkText> {
        let label: ref<inkText> = new inkText();
        label.SetName(name);
        label.SetText(value);
        label.SetFontFamily("base\\gameplay\\gui\\fonts\\raj\\raj.inkfontfamily");
        label.SetFontStyle(n"Medium");
        label.SetFontSize(size);
        label.SetSize(new Vector2(width, 72.0));
        label.SetMargin(new inkMargin(x, y, 0.0, 0.0));
        label.SetStyle(r"base\\gameplay\\gui\\common\\main_colors.inkstyle");
        label.BindProperty(n"tintColor", n"MainColors.Blue");
        label.SetInteractive(clickable);
        if clickable {
            label.RegisterToCallback(n"OnRelease", this, n"OnManagerClick");
        };
        label.Reparent(parent);
        return label;
    }

    private final func UpdateView() -> Void {
        if !IsDefined(this.m_player) {
            return;
        };
        let selected: Int32 = this.m_player.ConvaiManagerSelected();
        let i: Int32 = 0;
        while i < ArraySize(this.m_rows) {
            this.m_rows[i].SetOpacity(i == selected ? 1.0 : 0.55);
            i += 1;
        };
        this.m_status.SetText("SELECTED  //  " + this.m_player.ConvaiManagerName(selected));
        this.m_enable.SetText(this.m_player.ConvaiManagerEnabled(selected) ? "[ ENABLED ]  CLICK TO DISABLE" : "[ DISABLED ]  CLICK TO ENABLE");
        this.m_voice.SetText(this.m_player.ConvaiManagerVoice() ? "[ VOICE ON ]  CLICK TO MUTE" : "[ VOICE OFF ]  CLICK TO UNMUTE");
        this.m_subtitles.SetText(this.m_player.ConvaiManagerSubtitles() ? "[ SUBTITLES ON ]  CLICK TO HIDE" : "[ SUBTITLES OFF ]  CLICK TO SHOW");
    }

    protected cb func OnManagerClick(evt: ref<inkPointerEvent>) -> Bool {
        if !evt.IsAction(n"click") || !IsDefined(this.m_player) {
            return false;
        };
        let target: wref<inkWidget> = evt.GetCurrentTarget();
        let i: Int32 = 0;
        while i < ArraySize(this.m_rows) {
            if target == this.m_rows[i] {
                this.m_player.ConvaiManagerSelect(i);
                this.UpdateView();
                evt.Handle();
                return true;
            };
            i += 1;
        };
        if target == this.m_enable {
            let selected: Int32 = this.m_player.ConvaiManagerSelected();
            this.m_player.ConvaiManagerSetEnabled(selected, !this.m_player.ConvaiManagerEnabled(selected));
        } else {
            if target == this.m_voice {
                this.m_player.ConvaiManagerSetVoice(!this.m_player.ConvaiManagerVoice());
            } else {
                if target == this.m_subtitles {
                    this.m_player.ConvaiManagerSetSubtitles(!this.m_player.ConvaiManagerSubtitles());
                };
            };
        };
        this.UpdateView();
        evt.Handle();
        return true;
    }
}

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
    let popup: ref<ConvaiManagerPopup> = ConvaiManagerPopup.Create(this);
    this.m_convaiManagerPopup = popup;
    popup.Open(layer.GetGameController() as inkGameController);
    return true;
}

@addMethod(PlayerPuppet)
public final func ConvaiCloseManager() -> Bool {
    if !IsDefined(this.m_convaiManagerPopup) {
        return false;
    };
    let popup: ref<ConvaiManagerPopup> = this.m_convaiManagerPopup;
    this.m_convaiManagerPopup = null;
    popup.Close();
    return true;
}

@addMethod(PlayerPuppet)
public final func ConvaiManagerIsOpen() -> Bool {
    return IsDefined(this.m_convaiManagerPopup);
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
