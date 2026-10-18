// Generated from assets/facial/controls.json by Build-FacialGraphs.mjs.
// Zero values preserve the native face; this feature is applied only to owned copies.
public class ConvaiFaceFeature extends AnimFeature {
  public let jaw_mid_open: Float;
  public let jaw_mid_shift_fwd: Float;
  public let jaw_mid_shift_l: Float;
  public let jaw_mid_shift_r: Float;
  public let lips_apart_up: Float;
  public let lips_apart_dn: Float;
  public let lips_together_up: Float;
  public let lips_together_dn: Float;
  public let lips_l_funnel: Float;
  public let lips_r_funnel: Float;
  public let lips_l_purse: Float;
  public let lips_r_purse: Float;
  public let lips_l_stretch: Float;
  public let lips_r_stretch: Float;
  public let lips_l_corner_stretch: Float;
  public let lips_r_corner_stretch: Float;
  public let lips_l_corner_up: Float;
  public let lips_r_corner_up: Float;
  public let lips_l_corner_dn: Float;
  public let lips_r_corner_dn: Float;
  public let lips_l_upper_raise: Float;
  public let lips_r_upper_raise: Float;
  public let lips_l_lower_raise: Float;
  public let lips_r_lower_raise: Float;
  public let lips_tighten_up: Float;
  public let lips_tighten_dn: Float;
  public let lips_puff_up: Float;
  public let lips_puff_dn: Float;
  public let lips_suck_up: Float;
  public let lips_suck_dn: Float;
  public let lips_mid_shift_l: Float;
  public let lips_mid_shift_r: Float;
  public let cheek_l_puff: Float;
  public let cheek_r_puff: Float;
  public let cheek_l_suck: Float;
  public let cheek_r_suck: Float;
  public let eye_l_blink: Float;
  public let eye_r_blink: Float;
  public let eye_l_widen: Float;
  public let eye_r_widen: Float;
  public let eye_l_brows_raise_in: Float;
  public let eye_r_brows_raise_in: Float;
  public let eye_l_brows_raise_out: Float;
  public let eye_r_brows_raise_out: Float;
  public let eye_l_brows_lower: Float;
  public let eye_r_brows_lower: Float;
  public let eye_l_oculi_squint_outer_lower: Float;
  public let eye_r_oculi_squint_outer_lower: Float;
  public let tongue_mid_fwd: Float;
  public let tongue_mid_tip_up: Float;
  public let eye_l_brows_lateral: Float;
  public let eye_r_brows_lateral: Float;
  public let eye_l_oculi_squint_outer_upper: Float;
  public let eye_r_oculi_squint_outer_upper: Float;
  public let eye_l_oculi_squint_inner: Float;
  public let eye_r_oculi_squint_inner: Float;
  public let nose_l_snear: Float;
  public let nose_r_snear: Float;
  public let lips_chin_raise: Float;
  public let speech_owner: Float;
}

public abstract class ConvaiFaceAssets {
  public static func Names() -> array<String> {
    return ["man_average_sermo", "man_big_sermo", "man_fat_sermo", "woman_average_sermo", "player_man_photomode_sermo", "player_woman_photomode_sermo", "player_man_paperdoll_sermo", "player_woman_paperdoll_sermo", "pma_paperdoll_sermo"];
  }
  public static func RequiredTracks() -> array<CName> {
    return [n"jaw_mid_openLipsyncPoseOutput", n"jaw_mid_shift_fwdLipsyncPoseOutput", n"jaw_mid_shift_lLipsyncPoseOutput", n"jaw_mid_shift_rLipsyncPoseOutput", n"lips_apart_upLipsyncPoseOutput", n"lips_apart_dnLipsyncPoseOutput", n"lips_together_upLipsyncPoseOutput", n"lips_together_dnLipsyncPoseOutput", n"lips_l_funnelLipsyncPoseOutput", n"lips_r_funnelLipsyncPoseOutput", n"lips_l_purseLipsyncPoseOutput", n"lips_r_purseLipsyncPoseOutput", n"lips_l_stretchLipsyncPoseOutput", n"lips_r_stretchLipsyncPoseOutput", n"lips_l_corner_stretchLipsyncPoseOutput", n"lips_r_corner_stretchLipsyncPoseOutput", n"lips_l_corner_upLipsyncPoseOutput", n"lips_r_corner_upLipsyncPoseOutput", n"lips_l_corner_dnLipsyncPoseOutput", n"lips_r_corner_dnLipsyncPoseOutput", n"lips_l_upper_raiseLipsyncPoseOutput", n"lips_r_upper_raiseLipsyncPoseOutput", n"lips_l_lower_raiseLipsyncPoseOutput", n"lips_r_lower_raiseLipsyncPoseOutput", n"lips_tighten_upLipsyncPoseOutput", n"lips_tighten_dnLipsyncPoseOutput", n"lips_puff_upLipsyncPoseOutput", n"lips_puff_dnLipsyncPoseOutput", n"lips_suck_upLipsyncPoseOutput", n"lips_suck_dnLipsyncPoseOutput", n"lips_mid_shift_lLipsyncPoseOutput", n"lips_mid_shift_rLipsyncPoseOutput", n"cheek_l_puffLipsyncPoseOutput", n"cheek_r_puffLipsyncPoseOutput", n"cheek_l_suckLipsyncPoseOutput", n"cheek_r_suckLipsyncPoseOutput", n"eye_l_blinkLipsyncPoseOutput", n"eye_r_blinkLipsyncPoseOutput", n"eye_l_widenLipsyncPoseOutput", n"eye_r_widenLipsyncPoseOutput", n"eye_l_brows_raise_inLipsyncPoseOutput", n"eye_r_brows_raise_inLipsyncPoseOutput", n"eye_l_brows_raise_outLipsyncPoseOutput", n"eye_r_brows_raise_outLipsyncPoseOutput", n"eye_l_brows_lowerLipsyncPoseOutput", n"eye_r_brows_lowerLipsyncPoseOutput", n"eye_l_oculi_squint_outer_lowerLipsyncPoseOutput", n"eye_r_oculi_squint_outer_lowerLipsyncPoseOutput", n"tongue_mid_fwdLipsyncPoseOutput", n"tongue_mid_tip_upLipsyncPoseOutput", n"eye_l_brows_lateralLipsyncPoseOutput", n"eye_r_brows_lateralLipsyncPoseOutput", n"eye_l_oculi_squint_outer_upperLipsyncPoseOutput", n"eye_r_oculi_squint_outer_upperLipsyncPoseOutput", n"eye_l_oculi_squint_innerLipsyncPoseOutput", n"eye_r_oculi_squint_innerLipsyncPoseOutput", n"nose_l_snearLipsyncPoseOutput", n"nose_r_snearLipsyncPoseOutput", n"lips_chin_raiseLipsyncPoseOutput"];
  }
  public static func CrowdNames() -> array<String> {
    return ["man_average_sermo", "man_big_sermo", "man_fat_sermo", "woman_average_sermo"];
  }
  public static func CrowdFolder() -> String {
    return "cyberpunk_convai\\facial\\crowd\\";
  }
  public static func NamedRecords() -> array<String> {
    return ["Character.Alt", "Character.Bob", "Character.Carol", "Character.Cassidy", "Character.Claire", "Character.Dexter", "Character.EdgerunnersLucy", "Character.EdgerunnersLucy_Merc", "Character.Elcoyote_Barman", "Character.Elizabeth_Peralez", "Character.Evelyn", "Character.Hanako", "Character.Jackie", "Character.Jefferson_Peralez", "Character.Judy", "Character.Kerry", "Character.Lizzy_Wizzy", "Character.Mama_Welles", "Character.Misty", "Character.Mitch", "Character.Nancy", "Character.Nix", "Character.Ozob", "Character.Padre", "Character.Panam", "Character.Placide", "Character.Rogue", "Character.Santiago", "Character.Saul", "Character.Silverhand", "Character.Smasher", "Character.Sobchak", "Character.Stout", "Character.Takemura", "Character.Tbug", "Character.Thompson", "Character.Victor_Vector", "Character.Wilson", "Character.Yorinobu", "Character.alex", "Character.babs", "Character.dakota_smith", "Character.dyno", "Character.ina_06_tanner", "Character.jim_jarry", "Character.lizzies_bouncer", "Character.mq012_stud", "Character.mq015_seller", "Character.mq019_liam", "Character.mq024_sandra_combatable", "Character.mq038_darryl", "Character.mq040_wife", "Character.mq303_lina", "Character.mq303_shank", "Character.mq306_aaron", "Character.mr_hands", "Character.muamar_reyes", "Character.paco", "Character.q000_corpo_coach", "Character.q000_corpo_friend", "Character.q000_corpo_jenkins", "Character.q101_spider_murphy", "Character.q110_netwatch_agent", "Character.reed", "Character.reggie", "Character.songbird", "Character.sq017_blue_moon", "Character.sq021_joss", "Character.sq023_rachel", "Character.sts_ep1_03_client", "Character.sts_ep1_07_client", "Character.sts_ep1_08_bana", "Character.sts_ep1_08_client", "Character.sts_ep1_08_client_background", "Character.sts_ep1_10_bill", "Character.sts_ep1_12_alan_noel", "Character.sts_hey_gle_06_jake", "Character.sts_hey_rey_09_tobias", "Character.sts_wbr_jpn_01_sergei", "Character.sts_wbr_jpn_05_chang_hoon_nam", "Character.wakako_okada", "Character.wat_lch_melee_01", "NCA.Character.EdgerunnersLucy_Merc", "NCA.Character.lizzies_bouncer"];
  }
}
