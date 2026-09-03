#![no_std]
// WASM vanity search hot loop using the audited k256 (secp256k1) crate.
// Incremental point addition + batch normalization (batch inversion) + the free
// negation trick + prefix-bit leading-z check. Single-threaded per instance
// (one instance per Web Worker). Validated vs src/inj.mjs in test/wasm.test.mjs.

use k256::elliptic_curve::group::Curve;
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::elliptic_curve::PrimeField;
use k256::{AffinePoint, ProjectivePoint, Scalar};
use tiny_keccak::{Hasher, Keccak};

const BATCH: usize = 512;
const Z_VAL: u8 = 2; // bech32 value of 'z'
// secp256k1 field prime p (big-endian), for the free y -> p-y negation
const P_BE: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe, 0xff, 0xff, 0xfc, 0x2f,
];

// in-place y32 = p - y32 (big-endian), valid for 0 < y < p
fn neg_y(y: &mut [u8]) {
    let mut borrow: i32 = 0;
    let mut i = 31i32;
    while i >= 0 {
        let d = P_BE[i as usize] as i32 - y[i as usize] as i32 - borrow;
        if d < 0 {
            y[i as usize] = (d + 256) as u8;
            borrow = 1;
        } else {
            y[i as usize] = d as u8;
            borrow = 0;
        }
        i -= 1;
    }
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}

// ---- fixed scratch buffers exposed to JS (single instance per worker) ----
static mut SEED: [u8; 32] = [0; 32];   // JS writes the 256-bit start scalar here
static mut OUT: [u8; 53] = [0; 53];    // best: [count(1)][scalar(32)][addr(20)]

#[no_mangle]
pub extern "C" fn seed_ptr() -> *mut u8 {
    unsafe { SEED.as_mut_ptr() }
}
#[no_mangle]
pub extern "C" fn out_ptr() -> *mut u8 {
    unsafe { OUT.as_mut_ptr() }
}

// ---- global search state ----
static mut BASE: Scalar = Scalar::ZERO;
static mut CUR: ProjectivePoint = ProjectivePoint::IDENTITY;
static mut TRIES: u64 = 0;
static mut BEST_COUNT: i32 = -1;
static mut BEST_SCALAR: [u8; 32] = [0; 32];
static mut BEST_ADDR: [u8; 20] = [0; 20];

fn scalar_from_be(b: &[u8; 32]) -> Scalar {
    // reduce mod n so any 256-bit input is a valid scalar in [0, n)
    let mut acc = Scalar::ZERO;
    let byte_radix = Scalar::from(256u64);
    for &x in b.iter() {
        acc = acc * byte_radix + Scalar::from(x as u64);
    }
    acc
}

fn keccak20(xy: &[u8], out: &mut [u8; 20]) {
    let mut h = Keccak::v256();
    let mut digest = [0u8; 32];
    h.update(xy);
    h.finalize(&mut digest);
    out.copy_from_slice(&digest[12..32]);
}

fn leading_z(a: &[u8; 20]) -> i32 {
    let mut c = 0i32;
    let mut g = 0usize;
    while g < 32 {
        let bit = g * 5;
        let bp = bit >> 3;
        let rem = (bit & 7) as u32;
        let v = if rem <= 3 {
            (a[bp] >> (3 - rem)) & 31
        } else {
            (((a[bp] as u16) << (rem - 3)) | (a[bp + 1] as u16 >> (11 - rem))) as u8 & 31
        };
        if v == Z_VAL {
            c += 1;
        } else {
            break;
        }
        g += 1;
    }
    c
}
fn group(a: &[u8; 20], g: usize) -> u8 {
    let bit = g * 5;
    let bp = bit >> 3;
    let rem = (bit & 7) as u32;
    if rem <= 3 {
        (a[bp] >> (3 - rem)) & 31
    } else {
        (((a[bp] as u16) << (rem - 3)) | (a[bp + 1] as u16 >> (11 - rem))) as u8 & 31
    }
}
// ascii rank of bech32 charset "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
const CHARSET: [u8; 32] = *b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
fn better_lex(a: &[u8; 20], b: &[u8; 20]) -> bool {
    for g in 0..32 {
        let ra = CHARSET[group(a, g) as usize];
        let rb = CHARSET[group(b, g) as usize];
        if ra != rb {
            return ra > rb;
        }
    }
    false
}

unsafe fn consider(addr: &[u8; 20], scalar: &Scalar) {
    let count = leading_z(addr);
    let take = BEST_COUNT < 0
        || count > BEST_COUNT
        || (count == BEST_COUNT && count >= 1 && better_lex(addr, &BEST_ADDR));
    if take {
        BEST_COUNT = count;
        BEST_ADDR.copy_from_slice(addr);
        BEST_SCALAR.copy_from_slice(&scalar.to_bytes());
    }
}

#[no_mangle]
pub extern "C" fn init() {
    unsafe {
        BASE = scalar_from_be(&SEED);
        CUR = ProjectivePoint::GENERATOR * BASE;
        TRIES = 0;
        BEST_COUNT = -1;
    }
}

// run `iters` batches; returns total tries so far (as low 53 bits fit in f64/JS)
#[no_mangle]
pub extern "C" fn run(iters: u32) -> u64 {
    unsafe {
        let g = ProjectivePoint::GENERATOR;
        let mut projs = [ProjectivePoint::IDENTITY; BATCH];
        let mut affs = [AffinePoint::IDENTITY; BATCH];
        let mut addr = [0u8; 20];
        for _ in 0..iters {
            let mut cur = CUR;
            for i in 0..BATCH {
                projs[i] = cur;
                cur += g;
            }
            CUR = cur;
            ProjectivePoint::batch_normalize(&projs, &mut affs);
            let mut xy = [0u8; 64];
            for i in 0..BATCH {
                let s1 = BASE + Scalar::from(i as u64); // scalar of projs[i] = BASE + i
                let ep = affs[i].to_encoded_point(false);
                xy.copy_from_slice(&ep.as_bytes()[1..65]); // x(32) || y(32)
                keccak20(&xy, &mut addr);
                consider(&addr, &s1);
                // free negation: (x, p - y) corresponds to scalar -s1 = n - s1
                neg_y(&mut xy[32..64]);
                keccak20(&xy, &mut addr);
                consider(&addr, &(-s1));
                TRIES += 2;
            }
            BASE += Scalar::from(BATCH as u64);
        }
        // publish best into OUT
        OUT[0] = if BEST_COUNT < 0 { 0 } else { BEST_COUNT as u8 };
        OUT[1..33].copy_from_slice(&BEST_SCALAR);
        OUT[33..53].copy_from_slice(&BEST_ADDR);
        TRIES
    }
}

// verification helper: address for the scalar currently in SEED -> OUT[33..53]
#[no_mangle]
pub extern "C" fn addr_for_seed() {
    unsafe {
        let s = scalar_from_be(&SEED);
        let p = (ProjectivePoint::GENERATOR * s).to_affine();
        let ep = p.to_encoded_point(false);
        let b = ep.as_bytes();
        let mut addr = [0u8; 20];
        keccak20(&b[1..65], &mut addr);
        OUT[33..53].copy_from_slice(&addr);
        OUT[1..33].copy_from_slice(&s.to_bytes());
    }
}
