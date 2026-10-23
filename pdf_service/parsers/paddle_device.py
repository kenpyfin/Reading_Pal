"""
Resolve Paddle inference devices with safe defaults for older NVIDIA GPUs.

PaddlePaddle 3.x + CUDA 12 wheels target Pascal+ GPUs. Maxwell (e.g. Tesla M40,
compute capability 5.x) often loads models on GPU but segfaults during cuBLAS ops.
The pdf_service Docker image uses the cu118 wheel, which includes Maxwell support.
"""

from __future__ import annotations

import logging
import os
import subprocess
from typing import Optional

logger = logging.getLogger(__name__)

# Pascal (sm_60) and newer are generally stable with Paddle 3.x CUDA 12 builds.
_MIN_STABLE_COMPUTE_CAPABILITY = 6.0


def _paddle_cuda_major_version() -> Optional[int]:
    try:
        import paddle

        raw = str(paddle.version.cuda() or "")
        return int(raw.split(".", 1)[0]) if raw else None
    except Exception:
        return None


def _legacy_gpu_supported_by_paddle() -> bool:
    """CUDA 11.x Paddle wheels include Maxwell; CUDA 12.x wheels often do not."""
    major = _paddle_cuda_major_version()
    return major is not None and major < 12


def gpu_compute_capability() -> Optional[float]:
    """Return the first visible GPU's compute capability (e.g. 5.2, 7.5), or None."""
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=compute_cap", "--format=csv,noheader"],
            text=True,
            timeout=5,
        )
        first = out.strip().splitlines()[0].strip()
        major, minor = first.split(".", 1)
        return float(f"{major}.{minor}")
    except Exception:
        return None


def gpu_is_legacy_for_paddle3() -> bool:
    cap = gpu_compute_capability()
    return cap is not None and cap < _MIN_STABLE_COMPUTE_CAPABILITY


def resolve_paddle_device(env_var: str, default_gpu: str = "gpu:0") -> str:
    """
    Pick a Paddle device string from env, with automatic CPU fallback on legacy GPUs.

    When env_var is unset, Maxwell/Kepler GPUs default to CPU unless the caller
    passes an explicit default_gpu override via env (see PDF_LAYOUT_DEVICE).
    """
    explicit = os.getenv(env_var, "").strip()
    if explicit:
        return explicit

    cap = gpu_compute_capability()
    if (
        cap is not None
        and cap < _MIN_STABLE_COMPUTE_CAPABILITY
        and not _legacy_gpu_supported_by_paddle()
    ):
        logger.warning(
            "%s unset; GPU compute capability %.1f (Maxwell or older) is unreliable "
            "with PaddlePaddle CUDA 12 wheels — using CPU. Install the cu118 wheel or "
            "set %s=gpu:0 to force GPU.",
            env_var,
            cap,
            env_var,
        )
        return "cpu"
    return default_gpu
