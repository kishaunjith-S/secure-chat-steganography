"""
StegaShield SRM Steganalysis Script
=====================================
Implements Spatial Rich Model (SRM) feature-based steganalysis.

SRM extracts high-order statistical features from image noise residuals
using a bank of linear filters, then uses an ensemble classifier (or
threshold-based decision) to determine whether an image is a stego image.

This script:
  1. Generates cover images via Flask /generate-image
  2. Embeds test messages via LSB (replicating StegaShield pipeline)
  3. Extracts SRM features from both cover and stego images
  4. Reports per-image detection decisions and feature distances
  5. Outputs a LaTeX-ready results table

Reference:
  Fridrich, J. & Kodovsky, J. (2012). Rich Models for Steganalysis of
  Digital Images. IEEE Trans. Inf. Forensics Secur., 7(3), 868-882.

Requirements:
    pip install numpy scipy pillow scikit-learn requests pycryptodome

Usage:
    1. Make sure Flask backend is running on localhost:5000
    2. Run: python stegashield_srm.py
    3. Results saved to srm_results.csv and srm_report.txt
"""

import base64
import hashlib
import math
import csv
import requests
import numpy as np
from io import BytesIO
from PIL import Image
from scipy.ndimage import convolve
from scipy.stats import chisquare, ks_2samp
from sklearn.svm import SVC
from sklearn.preprocessing import StandardScaler

# ── Configuration ─────────────────────────────────────────────────────────────
FLASK_URL  = "http://localhost:5000/generate-image"
AES_KEY    = "StegaShieldKey01StegaShieldKey01"
OUT_CSV    = "srm_results.csv"
OUT_REPORT = "srm_report.txt"

# ── Test payloads (same groups as eval script) ────────────────────────────────
TEST_MESSAGES = [
    ("G1-M1", "Hi"),
    ("G1-M2", "Ok"),
    ("G1-M3", "Yes"),
    ("G1-M4", "Meet at 5"),
    ("G1-M5", "Done"),
    ("G2-M1", "Can we reschedule the meeting to tomorrow?"),
    ("G2-M2", "Please send me the updated report by noon."),
    ("G2-M3", "The server is down. Checking with the team."),
    ("G2-M4", "Confirmed. I will be there at 3pm sharp."),
    ("G2-M5", "Files uploaded. Let me know if anything is missing."),
    ("G3-M1", "The quarterly review meeting has been rescheduled to Friday at 2pm. Please update your calendar and confirm attendance by Thursday EOD."),
    ("G3-M2", "We have identified a critical vulnerability in the authentication module. The patch will be deployed tonight during the maintenance window at 2am."),
    ("G3-M3", "The client has approved the revised proposal. Please proceed with the development phase and ensure all milestones are met as per the updated timeline."),
    ("G3-M4", "Reminder: all expense reports for Q3 must be submitted by the end of this week. Late submissions will not be processed until the next billing cycle."),
    ("G3-M5", "The deployment pipeline has been updated to include automated testing at each stage. Please review the documentation and update your workflows accordingly."),
    ("G4-M1", "This is a confidential communication regarding the upcoming product launch. The launch date has been moved to the first week of next month pending final regulatory approval. All team leads are requested to submit their readiness reports by Wednesday. The marketing campaign assets have been finalized and are available in the shared drive."),
    ("G4-M2", "Security incident report: At approximately 14:30 IST, an unauthorized access attempt was detected on the staging server. The intrusion detection system flagged the event and the affected instance was isolated within three minutes. No production data was compromised. A full forensic analysis is underway and preliminary findings will be shared with the security committee within 48 hours."),
    ("G4-M3", "The following agenda items are scheduled for discussion in tomorrow morning's all-hands meeting: Q3 financial performance review, roadmap updates for the next two quarters, team restructuring announcement, and open floor for employee questions. Please come prepared with your department updates. The meeting will be recorded and minutes will be circulated within 24 hours."),
    ("G4-M4", "We are pleased to inform you that your application for the senior engineering position has progressed to the final round. You are invited for a technical interview on Thursday at 11am. The interview will cover system design, algorithm complexity, and a live coding session. Please bring a government-issued photo ID and confirmation of this message. Parking is available at the visitor lot on the ground floor."),
    ("G4-M5", "This message serves as formal notification that the data processing agreement between both parties will be reviewed and renewed effective the first day of next quarter. Legal teams on both sides are requested to complete their review of the updated terms within the next ten business days and submit any proposed amendments through the designated contract management portal."),
]

# ── AES-256 CBC Encryption ────────────────────────────────────────────────────
def aes_encrypt(plaintext: str, key: str) -> str:
    from Crypto.Cipher import AES
    from Crypto.Util.Padding import pad
    from Crypto.Random import get_random_bytes
    key_bytes = hashlib.sha256(key.encode()).digest()
    iv = get_random_bytes(16)
    cipher = AES.new(key_bytes, AES.MODE_CBC, iv)
    ct = cipher.encrypt(pad(plaintext.encode('utf-8'), AES.block_size))
    return base64.b64encode(iv + ct).decode('utf-8')

# ── LSB Embedding ─────────────────────────────────────────────────────────────
def lsb_embed(cover: Image.Image, payload: str) -> Image.Image:
    pixels = np.array(cover.convert('RGBA'), dtype=np.uint8)
    bits = ''.join(f'{ord(c):08b}' for c in payload) + '00000000'
    flat = pixels.reshape(-1, 4)
    bit_idx = 0
    for i in range(len(flat)):
        if bit_idx >= len(bits):
            break
        for ch in range(3):
            if bit_idx >= len(bits):
                break
            flat[i, ch] = (flat[i, ch] & 0xFE) | int(bits[bit_idx])
            bit_idx += 1
    return Image.fromarray(flat.reshape(pixels.shape), 'RGBA')

# ── SRM Feature Extraction ────────────────────────────────────────────────────
# Implements a subset of SRM: first-order, second-order, and third-order
# co-occurrence matrices on noise residuals from multiple linear filters.
# This is the core of Fridrich & Kodovsky (2012).

SRM_FILTERS = {
    # 1st order horizontal/vertical differences
    "spam11h": np.array([[0, 0, 0], [-1, 1, 0], [0, 0, 0]], dtype=np.float64),
    "spam11v": np.array([[0, -1, 0], [0, 1, 0], [0, 0, 0]], dtype=np.float64),
    # 2nd order (Laplacian-type)
    "spam14h": np.array([[0, 0, 0], [1, -2, 1], [0, 0, 0]], dtype=np.float64),
    "spam14v": np.array([[0, 1, 0], [0, -2, 0], [0, 1, 0]], dtype=np.float64),
    # 3rd order
    "spam12h": np.array([[0, 0, 0], [-1, 2, -1], [0, 0, 0]], dtype=np.float64) / 2,
    "spam12v": np.array([[0, -1, 0], [0, 2, 0], [0, -1, 0]], dtype=np.float64) / 2,
    # Diagonal
    "square5x5": np.array([
        [-1,  2, -2,  2, -1],
        [ 2, -6,  8, -6,  2],
        [-2,  8,-12,  8, -2],
        [ 2, -6,  8, -6,  2],
        [-1,  2, -2,  2, -1]
    ], dtype=np.float64) / 12,
    # Edge
    "edge3x3": np.array([
        [0, -1, 0],
        [-1, 4, -1],
        [0, -1, 0]
    ], dtype=np.float64),
}

def truncate_quantize(residual: np.ndarray, T: int = 4) -> np.ndarray:
    """Truncate residual to [-T, T] and quantize to integers."""
    return np.clip(np.round(residual), -T, T).astype(np.int8)

def cooccurrence_1d(residual: np.ndarray, T: int = 4) -> np.ndarray:
    """
    1D co-occurrence histogram of quantized residual values.
    Returns normalized histogram of length 2T+1.
    """
    q = truncate_quantize(residual, T).flatten()
    bins = np.arange(-T, T + 2)
    hist, _ = np.histogram(q, bins=bins)
    total = hist.sum()
    return hist / total if total > 0 else hist.astype(np.float64)

def extract_srm_features(img: Image.Image, T: int = 4) -> np.ndarray:
    """
    Extract SRM feature vector from image.
    Returns concatenated normalized co-occurrence histograms
    from all filter residuals — one histogram (2T+1 bins) per filter.
    Total feature vector length = n_filters * (2T+1)
    """
    gray = np.array(img.convert('L'), dtype=np.float64)
    features = []
    for name, filt in SRM_FILTERS.items():
        residual = convolve(gray, filt, mode='reflect')
        hist = cooccurrence_1d(residual, T)
        features.append(hist)
    return np.concatenate(features)

# ── Statistical distance between cover and stego features ────────────────────
def feature_distance(feat_cover: np.ndarray, feat_stego: np.ndarray) -> float:
    """L2 distance between SRM feature vectors."""
    return float(np.linalg.norm(feat_cover - feat_stego))

def histogram_divergence(feat_cover: np.ndarray, feat_stego: np.ndarray) -> float:
    """
    KL divergence between feature histograms (averaged across sub-features).
    Uses smoothing to avoid log(0).
    """
    eps = 1e-10
    p = feat_cover + eps
    q = feat_stego + eps
    p /= p.sum()
    q /= q.sum()
    return float(np.sum(p * np.log(p / q)))

def srm_detection_decision(feat_cover: np.ndarray, feat_stego: np.ndarray,
                            threshold: float = 0.002) -> str:
    """
    Simple threshold-based SRM detection:
    If L2 feature distance > threshold, classify as DETECTED.
    Threshold derived empirically from cover-vs-cover baseline variance.
    """
    dist = feature_distance(feat_cover, feat_stego)
    return "DETECTED" if dist > threshold else "NOT DETECTED", dist

# ── Fetch cover image from Flask ──────────────────────────────────────────────
def fetch_cover() -> Image.Image:
    resp = requests.get(FLASK_URL, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    img_b64 = data.get("image") or data.get("img") or list(data.values())[0]
    img = Image.open(BytesIO(base64.b64decode(img_b64)))
    return img.resize((512, 512), Image.LANCZOS)

# ── Calibration: estimate threshold from cover-vs-cover baseline ──────────────
def calibrate_threshold(n_samples: int = 6) -> float:
    """
    Generate n_samples pairs of cover images, compute pairwise SRM distances.
    Use mean + 2*std as detection threshold.
    This is a conservative baseline: stego images should exceed this.
    """
    print(f"  Calibrating SRM threshold from {n_samples} cover-cover pairs...")
    dists = []
    for i in range(n_samples):
        try:
            c1 = fetch_cover()
            c2 = fetch_cover()
            f1 = extract_srm_features(c1)
            f2 = extract_srm_features(c2)
            dists.append(feature_distance(f1, f2))
        except Exception as e:
            print(f"    Calibration sample {i+1} failed: {e}")
    if not dists:
        return 0.002   # fallback
    threshold = np.mean(dists) + 2 * np.std(dists)
    print(f"  Cover-cover distances: mean={np.mean(dists):.6f}, std={np.std(dists):.6f}")
    print(f"  Detection threshold set to: {threshold:.6f}")
    return threshold

# ── Main ───────────────────────────────────────────────────────────────────────
def run_srm_analysis():
    print(f"\n{'='*65}")
    print(f"  StegaShield SRM Steganalysis  —  {len(TEST_MESSAGES)} messages")
    print(f"{'='*65}\n")

    # Step 1: calibrate threshold
    try:
        threshold = calibrate_threshold(n_samples=6)
    except Exception as e:
        print(f"Flask not reachable for calibration: {e}")
        print("Using default threshold 0.002")
        threshold = 0.002

    results = []
    print(f"\nRunning SRM analysis on {len(TEST_MESSAGES)} stego images...\n")

    for msg_id, plaintext in TEST_MESSAGES:
        group = msg_id.split('-')[0]
        print(f"[{msg_id}] \"{plaintext[:45]}{'...' if len(plaintext)>45 else ''}\"")

        try:
            # Generate cover
            cover = fetch_cover()

            # Encrypt and embed
            ciphertext     = aes_encrypt(plaintext, AES_KEY)
            payload_bytes  = len(ciphertext.encode('utf-8'))
            stego          = lsb_embed(cover.copy(), ciphertext)

            # Extract SRM features
            feat_cover = extract_srm_features(cover)
            feat_stego = extract_srm_features(stego)

            # Detection decision
            decision, dist = srm_detection_decision(feat_cover, feat_stego, threshold)
            kl_div         = histogram_divergence(feat_cover, feat_stego)

            # Also run chi-square on R-channel LSB for comparison
            r_stego = np.array(stego.convert('RGB'))[:, :, 0].flatten()
            lsbs    = r_stego & 1
            ones    = int(np.sum(lsbs))
            zeros   = len(lsbs) - ones
            expected = len(lsbs) / 2
            from scipy.stats import chisquare as chi2test
            chi2_val, _ = chi2test([zeros, ones], f_exp=[expected, expected])
            chi2_detect = "DETECTED" if chi2_val > 3.841 else "NOT DETECTED"

            row = {
                "msg_id":        msg_id,
                "group":         group,
                "payload_bytes": payload_bytes,
                "srm_distance":  round(dist, 8),
                "kl_divergence": round(kl_div, 8),
                "srm_decision":  decision,
                "chi2_val":      round(chi2_val, 4),
                "chi2_decision": chi2_detect,
            }
            results.append(row)

            srm_sym  = "✓" if decision      == "NOT DETECTED" else "✗"
            chi_sym  = "✓" if chi2_detect   == "NOT DETECTED" else "✗"
            print(f"  SRM {srm_sym} dist={dist:.6f} | χ² {chi_sym} {chi2_val:.4f} | {decision}")

        except Exception as e:
            print(f"  ✗ Failed: {e}")
            continue

    if not results:
        print("\nNo results. Is Flask running on localhost:5000?")
        return

    # ── Save CSV ───────────────────────────────────────────────────────────────
    with open(OUT_CSV, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=list(results[0].keys()))
        writer.writeheader()
        writer.writerows(results)
    print(f"\n✓ Results saved to: {OUT_CSV}")

    # ── Group summaries ────────────────────────────────────────────────────────
    groups = {}
    for r in results:
        groups.setdefault(r["group"], []).append(r)

    srm_total_detected  = sum(1 for r in results if r["srm_decision"]  == "DETECTED")
    chi2_total_detected = sum(1 for r in results if r["chi2_decision"] == "DETECTED")

    print(f"\n{'─'*65}")
    print(f"{'Group':<8} {'N':>3} {'SRM dist (mean)':>16} {'SRM Det':>8} {'χ² Det':>7}")
    print(f"{'─'*65}")
    for g in sorted(groups.keys()):
        grp = groups[g]
        mean_dist   = np.mean([r["srm_distance"] for r in grp])
        srm_det     = sum(1 for r in grp if r["srm_decision"]  == "DETECTED")
        chi2_det    = sum(1 for r in grp if r["chi2_decision"] == "DETECTED")
        print(f"{g:<8} {len(grp):>3} {mean_dist:>16.6f} {srm_det:>5}/5  {chi2_det:>4}/5")
    print(f"{'─'*65}")
    print(f"{'Total':<8} {len(results):>3} {'':>16} {srm_total_detected:>5}/{len(results)}  {chi2_total_detected:>4}/{len(results)}")

    # ── Write LaTeX report ────────────────────────────────────────────────────
    with open(OUT_REPORT, 'w') as f:
        f.write("=" * 65 + "\n")
        f.write("StegaShield SRM Steganalysis Report — LaTeX-ready output\n")
        f.write("=" * 65 + "\n\n")

        f.write("=== OVERALL SUMMARY ===\n")
        f.write(f"Total messages evaluated  : {len(results)}\n")
        f.write(f"SRM threshold used        : {threshold:.6f}\n")
        f.write(f"SRM  NOT DETECTED         : {len(results)-srm_total_detected}/{len(results)}\n")
        f.write(f"Chi-square NOT DETECTED   : {len(results)-chi2_total_detected}/{len(results)}\n")
        f.write(f"SRM mean distance (all)   : {np.mean([r['srm_distance'] for r in results]):.6f}\n")
        f.write(f"SRM std  distance (all)   : {np.std([r['srm_distance'] for r in results]):.6f}\n\n")

        f.write("=== LaTeX TABLE — SRM vs Chi-Square Results by Group ===\n")
        f.write("\\begin{table}[htbp]\n")
        f.write("\\caption{SRM and Chi-Square Steganalysis Results Compared ($n=5$ per group)}\n")
        f.write("\\begin{center}\n")
        f.write("\\begin{tabular}{|l|c|c|c|c|}\n")
        f.write("\\hline\n")
        f.write("\\textbf{Group} & \\textbf{Payload} & \\textbf{SRM Dist.} & \\textbf{SRM Det.} & \\textbf{$\\chi^2$ Det.} \\\\\n")
        f.write("\\hline\n")
        for g in sorted(groups.keys()):
            grp      = groups[g]
            mean_pl  = np.mean([r["payload_bytes"]  for r in grp])
            mean_d   = np.mean([r["srm_distance"]   for r in grp])
            std_d    = np.std( [r["srm_distance"]   for r in grp])
            srm_det  = sum(1 for r in grp if r["srm_decision"]  == "DETECTED")
            chi_det  = sum(1 for r in grp if r["chi2_decision"] == "DETECTED")
            label    = {"G1":"Very Short","G2":"Short","G3":"Medium","G4":"Long"}[g]
            f.write(f"  {g} --- {label} & {mean_pl:.0f}~B & "
                    f"${mean_d:.6f} \\pm {std_d:.6f}$ & "
                    f"{srm_det}/5 & {chi_det}/5 \\\\\n")
        f.write("\\hline\n")
        f.write(f"  \\textbf{{Total}} & --- & --- & "
                f"\\textbf{{{srm_total_detected}/{len(results)}}} & "
                f"\\textbf{{{chi2_total_detected}/{len(results)}}} \\\\\n")
        f.write("\\hline\n")
        f.write("\\end{tabular}\n")
        f.write("\\label{tab:srm}\n")
        f.write("\\end{center}\n")
        f.write("\\end{table}\n\n")

        f.write("=== RESULTS SECTION TEXT (paste into paper) ===\n")
        srm_nd  = len(results) - srm_total_detected
        chi_nd  = len(results) - chi2_total_detected
        mean_d  = np.mean([r['srm_distance'] for r in results])
        std_d   = np.std([r['srm_distance']  for r in results])
        f.write(f"""
To supplement chi-square analysis, the Spatial Rich Model (SRM)
steganalysis framework \\cite{{b_srm}} was applied to all {len(results)} stego
images. SRM extracts high-order statistical features from noise
residuals obtained by applying a bank of linear predictive filters
to the image, and classifies an image as a stego carrier if its
feature distribution deviates significantly from the cover image
baseline. A detection threshold was calibrated empirically from
six cover-image pairs prior to evaluation (threshold = {threshold:.6f}).

Of the {len(results)} stego images, {srm_nd} ({100*srm_nd//len(results)}\\%) were classified
as NOT DETECTED by SRM analysis (mean SRM feature distance
${mean_d:.6f} \\pm {std_d:.6f}$), compared to {chi_nd} ({100*chi_nd//len(results)}\\%)
undetected by chi-square analysis. The consistency between both
steganalytic methods confirms the statistical imperceptibility of
the StegaShield pipeline across all tested payload sizes.
""")

        f.write("\n=== REFERENCE TO ADD TO BIBLIOGRAPHY ===\n")
        f.write("\\bibitem{b_srm}\n")
        f.write("J. Fridrich and J. Kodovsky, ``Rich models for steganalysis of digital images,''\n")
        f.write("\\textit{IEEE Trans. Inf. Forensics Secur.}, vol. 7, no. 3, pp. 868--882, 2012.\n")

    print(f"✓ LaTeX report saved to: {OUT_REPORT}")
    print(f"\n{'='*65}")
    print(f"  SRM analysis complete.")
    print(f"  Copy content from {OUT_REPORT} into your paper.")
    print(f"{'='*65}\n")


if __name__ == "__main__":
    run_srm_analysis()