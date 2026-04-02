"""
train_gan.py  —  Fast DCGAN trainer (~2-3 minutes on CPU)
Trains on 5,000 CIFAR-10 images for 3 epochs instead of 50,000 x 5.
Result is a real trained GAN — just faster.

Usage:
    python train_gan.py
"""

import torch
import torch.nn as nn
import torch.optim as optim
import torchvision
import torchvision.transforms as transforms
from torch.utils.data import DataLoader, Subset

DEVICE      = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
NZ          = 100    # latent vector size
NGF         = 64
NDF         = 64
BATCH_SIZE  = 128
EPOCHS      = 3
LR          = 0.0002
SUBSET_SIZE = 5000   # use 5k images instead of 50k — 10x faster, still trains well
OUT_FILE    = "generator.pth"

print(f"Device : {DEVICE}")
print(f"Images : {SUBSET_SIZE} | Epochs: {EPOCHS} | Batch: {BATCH_SIZE}")


# ── Architecture (Radford et al. 2015) ───────────────────────────

class Generator(nn.Module):
    def __init__(self):
        super().__init__()
        self.main = nn.Sequential(
            nn.ConvTranspose2d(NZ,    NGF*8, 4, 1, 0, bias=False),
            nn.BatchNorm2d(NGF*8), nn.ReLU(True),
            nn.ConvTranspose2d(NGF*8, NGF*4, 4, 2, 1, bias=False),
            nn.BatchNorm2d(NGF*4), nn.ReLU(True),
            nn.ConvTranspose2d(NGF*4, NGF*2, 4, 2, 1, bias=False),
            nn.BatchNorm2d(NGF*2), nn.ReLU(True),
            nn.ConvTranspose2d(NGF*2, NGF,   4, 2, 1, bias=False),
            nn.BatchNorm2d(NGF),   nn.ReLU(True),
            nn.ConvTranspose2d(NGF,   3,     4, 2, 1, bias=False),
            nn.Tanh()
        )
    def forward(self, z):
        return self.main(z)


class Discriminator(nn.Module):
    def __init__(self):
        super().__init__()
        self.main = nn.Sequential(
            nn.Conv2d(3,     NDF,   4, 2, 1, bias=False),
            nn.LeakyReLU(0.2, inplace=True),
            nn.Conv2d(NDF,   NDF*2, 4, 2, 1, bias=False),
            nn.BatchNorm2d(NDF*2), nn.LeakyReLU(0.2, inplace=True),
            nn.Conv2d(NDF*2, NDF*4, 4, 2, 1, bias=False),
            nn.BatchNorm2d(NDF*4), nn.LeakyReLU(0.2, inplace=True),
            nn.Conv2d(NDF*4, NDF*8, 4, 2, 1, bias=False),
            nn.BatchNorm2d(NDF*8), nn.LeakyReLU(0.2, inplace=True),
            nn.Conv2d(NDF*8, 1,     4, 1, 0, bias=False),
            nn.Sigmoid()
        )
    def forward(self, img):
        return self.main(img).view(-1)


def weights_init(m):
    cls = m.__class__.__name__
    if 'Conv' in cls:
        nn.init.normal_(m.weight.data, 0.0, 0.02)
    elif 'BatchNorm' in cls:
        nn.init.normal_(m.weight.data, 1.0, 0.02)
        nn.init.constant_(m.bias.data, 0)


# ── Dataset: 5k subset of CIFAR-10 ──────────────────────────────
print("Loading CIFAR-10 subset...")
transform = transforms.Compose([
    transforms.Resize(64),
    transforms.CenterCrop(64),
    transforms.ToTensor(),
    transforms.Normalize((0.5,)*3, (0.5,)*3),
])
full_dataset = torchvision.datasets.CIFAR10(
    root='./data', train=True, download=True, transform=transform
)
dataset    = Subset(full_dataset, list(range(SUBSET_SIZE)))
dataloader = DataLoader(dataset, batch_size=BATCH_SIZE, shuffle=True,
                        num_workers=0, drop_last=True)

batches = len(dataloader)
print(f"Batches per epoch: {batches}  (~{batches * EPOCHS} total steps)")


# ── Init ─────────────────────────────────────────────────────────
G = Generator().to(DEVICE)
D = Discriminator().to(DEVICE)
G.apply(weights_init)
D.apply(weights_init)

criterion = nn.BCELoss()
opt_G = optim.Adam(G.parameters(), lr=LR, betas=(0.5, 0.999))
opt_D = optim.Adam(D.parameters(), lr=LR, betas=(0.5, 0.999))

print(f"\nTraining started — estimated time: 2-4 minutes on CPU\n{'='*50}")


# ── Training loop ────────────────────────────────────────────────
for epoch in range(1, EPOCHS + 1):
    for i, (real_imgs, _) in enumerate(dataloader):
        real_imgs = real_imgs.to(DEVICE)
        b = real_imgs.size(0)

        # Train Discriminator
        D.zero_grad()
        label_real = torch.ones(b,  device=DEVICE)
        label_fake = torch.zeros(b, device=DEVICE)

        loss_D = (criterion(D(real_imgs), label_real) +
                  criterion(D(G(torch.randn(b, NZ, 1, 1, device=DEVICE)).detach()), label_fake))
        loss_D.backward()
        opt_D.step()

        # Train Generator
        G.zero_grad()
        fake = G(torch.randn(b, NZ, 1, 1, device=DEVICE))
        loss_G = criterion(D(fake), label_real)   # G wants D to say "real"
        loss_G.backward()
        opt_G.step()

    print(f"Epoch {epoch}/{EPOCHS} — D loss: {loss_D.item():.4f} | G loss: {loss_G.item():.4f}")

# ── Save ─────────────────────────────────────────────────────────
torch.save(G.state_dict(), OUT_FILE)
print(f"\nDone! Generator saved to: {OUT_FILE}")
print("Now run: python app.py")