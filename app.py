"""
GAN Backend - Flask API
Loads the DCGAN Generator trained by train_gan.py (generator.pth).
Run train_gan.py ONCE first to produce the weights file.

SETUP:
    pip install flask flask-cors torch torchvision pillow numpy
    python train_gan.py        # ~2-4 min on CPU
    python app.py

Generate: GET http://localhost:5000/generate-image
Health:   GET http://localhost:5000/health
"""

from flask import Flask, jsonify
from flask_cors import CORS
from PIL import Image
import io, base64, os
import numpy as np
import torch
import torch.nn as nn

app = Flask(__name__)
CORS(app)


# ─────────────────────────────────────────────────────────────────
# DCGAN Architecture  (Radford et al., arXiv:1511.06434)
# Must match the architecture in train_gan.py exactly.
# ─────────────────────────────────────────────────────────────────

class DCGANGenerator(nn.Module):
    """
    DCGAN Generator.
    Input : latent vector z  [batch, nz, 1, 1]   z ~ N(0, 1)
    Output: RGB image        [batch, 3, 64, 64]   values in [-1, 1]
    """
    def __init__(self, nz=100, ngf=64, nc=3):
        super().__init__()
        self.nz = nz
        self.main = nn.Sequential(
            nn.ConvTranspose2d(nz,    ngf*8, 4, 1, 0, bias=False),
            nn.BatchNorm2d(ngf*8), nn.ReLU(True),
            nn.ConvTranspose2d(ngf*8, ngf*4, 4, 2, 1, bias=False),
            nn.BatchNorm2d(ngf*4), nn.ReLU(True),
            nn.ConvTranspose2d(ngf*4, ngf*2, 4, 2, 1, bias=False),
            nn.BatchNorm2d(ngf*2), nn.ReLU(True),
            nn.ConvTranspose2d(ngf*2, ngf,   4, 2, 1, bias=False),
            nn.BatchNorm2d(ngf),   nn.ReLU(True),
            nn.ConvTranspose2d(ngf,   nc,    4, 2, 1, bias=False),
            nn.Tanh()
            # Output: 3 x 64 x 64
        )

    def forward(self, z):
        return self.main(z)


class DCGANDiscriminator(nn.Module):
    """
    DCGAN Discriminator.
    Input : RGB image [batch, 3, 64, 64]
    Output: probability scalar  (real=1 / fake=0)
    Not used for inference — included to show complete GAN architecture.
    """
    def __init__(self, ndf=64, nc=3):
        super().__init__()
        self.main = nn.Sequential(
            nn.Conv2d(nc,    ndf,   4, 2, 1, bias=False),
            nn.LeakyReLU(0.2, inplace=True),
            nn.Conv2d(ndf,   ndf*2, 4, 2, 1, bias=False),
            nn.BatchNorm2d(ndf*2), nn.LeakyReLU(0.2, inplace=True),
            nn.Conv2d(ndf*2, ndf*4, 4, 2, 1, bias=False),
            nn.BatchNorm2d(ndf*4), nn.LeakyReLU(0.2, inplace=True),
            nn.Conv2d(ndf*4, ndf*8, 4, 2, 1, bias=False),
            nn.BatchNorm2d(ndf*8), nn.LeakyReLU(0.2, inplace=True),
            nn.Conv2d(ndf*8, 1,     4, 1, 0, bias=False),
            nn.Sigmoid()
        )

    def forward(self, img):
        return self.main(img).view(-1)


# ─────────────────────────────────────────────────────────────────
# Load Generator weights
# ─────────────────────────────────────────────────────────────────
NZ          = 100
WEIGHTS_FILE = "generator.pth"

generator     = DCGANGenerator(nz=NZ, ngf=64, nc=3)
discriminator = DCGANDiscriminator(ndf=64, nc=3)   # shown for completeness

weights_loaded = False

if os.path.exists(WEIGHTS_FILE):
    try:
        state = torch.load(WEIGHTS_FILE, map_location="cpu", weights_only=True)
        generator.load_state_dict(state)
        weights_loaded = True
        print(f"Loaded trained weights from {WEIGHTS_FILE}")
    except Exception as e:
        print(f"Could not load {WEIGHTS_FILE}: {e}")
        print("Run 'python train_gan.py' first to generate weights.")
else:
    print(f"WARNING: {WEIGHTS_FILE} not found.")
    print("Run 'python train_gan.py' first, then restart app.py.")
    print("Server will start but images will be from random-init generator.")

generator.eval()

g_params = sum(p.numel() for p in generator.parameters())
d_params = sum(p.numel() for p in discriminator.parameters())
print(f"Generator params    : {g_params:,}")
print(f"Discriminator params: {d_params:,}")


# ─────────────────────────────────────────────────────────────────
# Image generation
# ─────────────────────────────────────────────────────────────────
def generate_image_base64() -> str:
    # Sample random latent vector z ~ N(0,1)  — core GAN operation
    z = torch.randn(1, NZ, 1, 1)

    with torch.no_grad():
        fake = generator(z)             # [1, 3, 64, 64], values in [-1, 1]

    # Rescale to [0, 255]
    img_tensor = (fake[0].clamp(-1, 1) + 1) / 2      # [0, 1]
    img_np = (img_tensor.permute(1, 2, 0).numpy() * 255).astype(np.uint8)

    image = Image.fromarray(img_np, 'RGB')
    # Upscale to 512×512 — more pixels = more LSB steganography capacity
    image = image.resize((512, 512), Image.LANCZOS)

    # PNG = lossless — LSB steganography bits survive intact
    buf = io.BytesIO()
    image.save(buf, format="PNG")

    mode = "trained" if weights_loaded else "random-init"
    print(f"GAN image generated | weights={mode} | z.norm={z.norm().item():.3f}")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


# ─────────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────────
@app.route("/generate-image", methods=["GET"])
def generate_image():
    return jsonify({"image": generate_image_base64()})


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status"               : "ok",
        "architecture"         : "DCGAN (Radford et al. 2015)",
        "weights"              : "trained on CIFAR-10" if weights_loaded else "random-init (run train_gan.py)",
        "generator_params"     : g_params,
        "discriminator_params" : d_params,
        "output_size"          : "512x512 PNG (upscaled from 64x64)",
    })


if __name__ == "__main__":
    print("\nServer:   http://localhost:5000")
    print("Health:   http://localhost:5000/health")
    print("Generate: http://localhost:5000/generate-image\n")
    app.run(debug=False, port=5000)