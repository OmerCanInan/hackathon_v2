import urllib.request
import json
import time
import random
import uuid

print("100 Farkli Ihbar Simulasyonu baslatiliyor...")

# simulate.py dosyasındaki 300 farklı durumu alalım
with open("simulate.py", "r", encoding="utf-8") as f:
    lines = f.readlines()

# simulate.py'deki rows = [ ... ] listesi 7. satır ile 308. satır arasındaydı
rows_str = "".join(lines[6:308])
# Sadece liste elemanlarını güvenli şekilde parse edelim
import ast
rows = ast.literal_eval(rows_str.replace("rows = ", "").strip())

# 100 tanesini rastgele seçelim
random.shuffle(rows)
selected_rows = rows[:100]

url = 'http://localhost:3001/api/packet'

for i, row in enumerate(selected_rows):
    id_num, payload_text, persons, score, severity, note = row
    device_id = f"normal-sim-{i}"
    
    # 0-49: Erzurum
    # 50-99: Türkiye Geneli
    if i < 50:
        lat = 39.90 + random.uniform(-0.05, 0.05)
        lng = 41.27 + random.uniform(-0.05, 0.05)
        bolge = "Erzurum"
    else:
        lat = 36.0 + random.uniform(0, 6.0)
        lng = 26.0 + random.uniform(0, 19.0)
        bolge = "Turkiye"
        
    data = {
        "packet_uuid": str(uuid.uuid4()),
        "device_id": device_id,
        "payload": payload_text,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "origin_location": {"lat": lat, "lng": lng},
        "last_seen_location": {"lat": lat, "lng": lng},
        "schema_version": "1.0",
        "iteration_count": 0
    }
    
    req = urllib.request.Request(url, data=json.dumps(data).encode('utf-8'), headers={'Content-Type': 'application/json'})
    
    try:
        response = urllib.request.urlopen(req)
        # Sadece ilk 50 karakterini ekrana basarak ne gönderdiğimizi görelim
        print(f"[{i+1}/100] OK: {bolge} - {payload_text[:40]}...")
    except Exception as e:
        print(f"[{i+1}/100] HATA: {e}")
        
    time.sleep(0.3)

print("100 paket gonderimi tamamlandi! Dashboard'dan inceleyebilirsiniz.")
