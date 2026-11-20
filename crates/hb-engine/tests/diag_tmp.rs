mod common;
use common::*;

#[test]
fn diag() {
    for &f in &[5.0f64, 10.0, 20.0] {
        let mut errs = Vec::new(); let mut zs = Vec::new();
        for seed in 0..6u64 {
            let ch = four((70.0 * RATE) as usize, 1.5, &[Rhythm { f, bw: 0.3, snr_db: 10.0 }], 12.0, 500 + seed);
            let (frames, _) = run(&ch, 1, &[]);
            let s = slow(&frames);
            let last = s.last().unwrap();
            if let Some(tr) = track_near(last, f, 0.1 * f) {
                let fi = tr.freq_integrated.v.unwrap(); let se = tr.freq_integrated.se.unwrap();
                errs.push(100.0 * (fi - f) / f); zs.push((fi - f) / se);
            }
        }
        let me = errs.iter().sum::<f64>() / errs.len() as f64;
        println!("f {f}: errors % {:?} mean {me:.2}; z {:?}", errs.iter().map(|v| (v*100.0).round()/100.0).collect::<Vec<_>>(), zs.iter().map(|v| (v*10.0).round()/10.0).collect::<Vec<_>>());
    }
}
