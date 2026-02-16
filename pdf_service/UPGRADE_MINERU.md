# Upgrading MinerU (magic-pdf) for ReadingPal PDF Service

The PDF service uses MinerU (PyPI package `magic-pdf`) for PDF → Markdown conversion. This project supports **both** the 0.10.x API (OCRPipe, pipe_mk_markdown) and the 1.3.x API (PymuDocDataset, pipe_ocr_mode/pipe_txt_mode, get_markdown). The correct path is chosen at import time, so you can upgrade the package without changing code.

## Steps to upgrade

1. **Activate the MinerU Conda environment** (the one used by `start_services.sh`):
   ```bash
   conda activate MinerU
   ```

2. **Upgrade magic-pdf** (full install includes OCR and model dependencies):
   ```bash
   pip install -U "magic-pdf[full]"
   ```

3. **Restart the PDF service**
   - If you use `start_services.sh`: stop it (Ctrl+C), then run `bash start_services.sh` again.
   - If you run the service manually: stop the process that runs `pdf_service/app.py`, then start it again with the same Python interpreter (e.g. `.../envs/MinerU/bin/python pdf_service/app.py`).

4. **Test with a real PDF**
   - Upload a PDF through the app and confirm the job completes and the resulting markdown and images look correct.
   - Check logs for: `Using MinerU 1.3 API` or `Using MinerU 0.10 API` to see which path is in use.

## If something breaks after upgrade

- **ImportError or AttributeError on startup**: The compatibility layer in `app.py` will try the 0.10 API first, then fall back to the 1.3 API. If both fail, ensure the environment has a single, consistent install: `pip install -U "magic-pdf[full]"` and no conflicting `mineru` or local magic_pdf installs.
- **Errors during processing**: Check that model weights (e.g. layout/OCR models) are still in the expected paths; MinerU docs describe downloading them if needed.
- **Different output**: 1.3 may produce slightly different markdown or image paths; the app normalizes image paths to `/images/app/...` for both API paths.

### OpenCV `cv2.mean` error in OCR (standalone)

If you see an error like:
```text
cv2.error: OpenCV(4.6.0) ... in function 'mean'
  src data type = 23 is not supported
```
it comes from MinerU’s OCR postprocessing; some OpenCV versions don’t accept the array type passed there.

- **First try** upgrading to the version requested by other deps (albucore/albumentations):  
  `pip install "opencv-python-headless>=4.9.0.80"`  
  If the OCR error goes away with a newer OpenCV, you avoid conflicts.
- **If the error persists**, pin to an older compatible version:  
  `pip install "opencv-python-headless==4.8.1.78"`  
  You may see pip warnings that albucore/albumentations want ≥4.9; those are optional. If PDF processing and layout/OCR work, you can ignore the warnings.

Then restart the PDF service.

### Other dependency warnings (unimernet / transformers)

If pip reports that **unimernet** requires `transformers==4.42.4` while you have a different version: with **formula recognition disabled** in `magic-pdf.json`, the MFR (unimernet) model is not loaded, so that conflict is harmless. If you re-enable formula later, pin `transformers` in the MinerU env to satisfy unimernet (e.g. `pip install "transformers==4.42.4"`) and accept any side effects for other packages.

## Optional: pin a version

To avoid surprise upgrades, you can pin after verifying a version works:

```bash
pip install -U "magic-pdf[full]==1.3.12"
```

Then document the chosen version in `pdf_service/requirements.txt` or in this file for future reference.
