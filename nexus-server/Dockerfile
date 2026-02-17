FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Expose port for WebSocket and dashboard
EXPOSE 8765

# Environment variables (can be overridden)
ENV HOST=0.0.0.0
ENV PORT=8765

# Run the server
CMD ["python", "main.py"]
