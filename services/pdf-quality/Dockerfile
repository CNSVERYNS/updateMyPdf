FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-dejavu \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir -r requirements.txt
COPY app.py test_quality.py ./

ENV MIN_ACCEPTABLE_FONT_SIZE=5
ENV QUALITY_PASS_SCORE=90
ENV QUALITY_WARNING_SCORE=70
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
