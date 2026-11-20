mod common;
use common::*;
use hb_engine::prng::Rng;
use hb_engine::spectral::WindowAnalyzer;
use hb_engine::Params;

#[test]
fn diag() {
    for win in [8.0f64, 4.0] {
        let mut p = Params::default();
        p.slow_window_s = win;
        let wa = WindowAnalyzer::new(p.clone(), RATE);
        let n = wa.window_len();
        let mut rng = Rng::new(7);
        let trials = 5000;
        let (mut hp, mut pk) = (0, 0);
        for i in 0..trials {
            let chi = [0.0, 1.0, 1.5, 2.0, 2.5][i % 5];
            let x = synth(n, chi, &[], 10.0, &mut rng);
            let xf: Vec<f32> = x.iter().map(|v| *v as f32).collect();
            let a = wa.analyse(&xf, &[50.0]);
            if a.height_passes > 0 { hp += 1; }
            if !a.peaks.is_empty() { pk += 1; }
        }
        println!("window {win}: height {:.4} peaks {:.4}", hp as f64/trials as f64, pk as f64/trials as f64);
    }
}
