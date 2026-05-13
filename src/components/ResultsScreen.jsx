import streamlit as st
import pandas as pd
import numpy as np
import random
import statsapi
import requests
import datetime
import time
import json
import os
import concurrent.futures
import urllib.parse
import base64
import platform
from datetime import timedelta
import pybaseball
from pybaseball import statcast_pitcher, statcast_batter, playerid_lookup
from numba import njit
import warnings
import re
warnings.filterwarnings('ignore')

# --- SOURCE TRACKING ---
LAST_EDIT_SOURCE = "🍏 Local Mac" 

# --- ENABLE LOCAL HARD DRIVE CACHING ---
pybaseball.cache.enable()

# --- TELEGRAM BOT CREDENTIALS ---
TELEGRAM_TOKEN = "8689228116:AAHoJh4uOhSTBZVrl5ZAb75QvG3X2BZ8sek"
TELEGRAM_CHAT_ID = "364372310"

def get_runtime_environment():
    system = platform.system()
    if system == "Windows": return "💻 Local Windows PC"
    elif system == "Darwin": return "🍏 Local Mac"
    elif system == "Linux": return "☁️ Streamlit Cloud Server"
    else: return f"❓ Unknown System ({system})"

def send_telegram_alert(message_html):
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    message_html = message_html.replace(' < ', ' under ').replace(' > ', ' over ').replace(' & ', ' and ')
    
    parts = message_html.split('\n\n')
    chunks, current_chunk = [], ""
    
    for part in parts:
        if len(current_chunk) + len(part) + 2 > 3900:
            chunks.append(current_chunk)
            current_chunk = part
        else:
            if current_chunk: current_chunk += "\n\n" + part
            else: current_chunk = part
                
    if current_chunk: chunks.append(current_chunk)
        
    success = True
    for i, chunk in enumerate(chunks):
        payload = {"chat_id": TELEGRAM_CHAT_ID, "text": chunk, "parse_mode": "HTML"}
        try:
            response = requests.post(url, json=payload)
            if response.status_code != 200:
                st.error(f"Telegram Failed to Send Part {i+1}: {response.text}")
                success = False
        except Exception as e:
            st.error(f"Telegram Network Error on Part {i+1}: {e}")
            success = False
        time.sleep(0.5) 
        
    if success: st.success("📲 Telegram alert sent successfully!")

# --- APP STATE MACHINE INITIALIZATION ---
if 'app_state' not in st.session_state: st.session_state.app_state = 'idle'
if 'run_payload' not in st.session_state: st.session_state.run_payload = None

# --- UI Configuration & Static Background ---
st.set_page_config(page_title="MLB Quant Dashboard v96", layout="wide", page_icon="⚾")

page_bg_css = """
<style>
.stApp {
    background-image: url('https://images.unsplash.com/photo-1557004396-66e4174d7bf6?q=80&w=2000&auto=format&fit=crop');
    background-size: cover;
    background-attachment: fixed;
    background-position: center;
    background-color: rgba(255, 255, 255, 0.85); 
    background-blend-mode: overlay;
}
.stApp > header { background-color: transparent; }
.st-emotion-cache-1wmy9hl, .st-emotion-cache-1y4p8pa {
    background-color: rgba(255, 255, 255, 0.95) !important;
    border-radius: 10px;
    padding: 20px;
    box-shadow: 0px 4px 10px rgba(0,0,0,0.1);
}
</style>
"""
st.markdown(page_bg_css, unsafe_allow_html=True)

# ==========================================
# 0. DATABASE / PERSISTENCE & BULLETPROOF GITHUB SYNC
# ==========================================
DB_FILE = "prediction_history.json"

def backup_to_github():
    try:
        if not hasattr(st, "secrets"): return
        token = st.secrets.get("GITHUB_TOKEN", None)
        repo = st.secrets.get("GITHUB_REPO", None)
        if not token or not repo: return 
        url = f"https://api.github.com/repos/{repo}/contents/{DB_FILE}"
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github.v3+json"}
        get_resp = requests.get(url, headers=headers)
        sha = get_resp.json().get("sha") if get_resp.status_code == 200 else None
        
        with open(DB_FILE, "r") as f: content = f.read()
        encoded_content = base64.b64encode(content.encode('utf-8')).decode('utf-8')
        local_time = datetime.datetime.utcnow() + timedelta(hours=3)
        payload = {"message": f"Auto-backup database: {local_time.strftime('%Y-%m-%d %H:%M')}", "content": encoded_content}
        if sha: payload["sha"] = sha
        requests.put(url, headers=headers, json=payload)
    except Exception: pass 

def load_history():
    if os.path.exists(DB_FILE):
        with open(DB_FILE, "r") as f: return json.load(f)
    return []

def save_daily_master(daily_record):
    history = load_history()
    local_time = datetime.datetime.utcnow() + timedelta(hours=3)
    daily_record['timestamp'] = local_time.strftime("%Y-%m-%d %H:%M:%S")
    idx = next((i for i, r in enumerate(history) if r.get('date') == daily_record['date']), None)
    if idx is not None: history[idx] = daily_record
    else: history.append(daily_record)
    with open(DB_FILE, "w") as f: json.dump(history, f, indent=4)
    backup_to_github()

def delete_daily_master(date_str):
    history = load_history()
    history = [run for run in history if run.get('date') != date_str]
    with open(DB_FILE, "w") as f: json.dump(history, f, indent=4)
    backup_to_github()

# ==========================================
# 1. LIVE DATA ACQUISITION & METEOROLOGY
# ==========================================

MLB_ZIP_CODES = {
    'Arizona Diamondbacks': '85004', 'Atlanta Braves': '30339', 'Baltimore Orioles': '21201',
    'Boston Red Sox': '02215', 'Chicago Cubs': '60613', 'Chicago White Sox': '60616',
    'Cincinnati Reds': '45202', 'Cleveland Guardians': '44115', 'Colorado Rockies': '80205',
    'Detroit Tigers': '48201', 'Houston Astros': '77002', 'Kansas City Royals': '64129',
    'Los Angeles Angels': '92806', 'Los Angeles Dodgers': '90012', 'Miami Marlins': '33132',
    'Milwaukee Brewers': '53214', 'Minnesota Twins': '55403', 'New York Mets': '11368',
    'New York Yankees': '10451', 'Oakland Athletics': '94621', 'Philadelphia Phillies': '19148',
    'Pittsburgh Pirates': '15212', 'San Diego Padres': '92101', 'San Francisco Giants': '94107',
    'Seattle Mariners': '98134', 'St. Louis Cardinals': '63102', 'Tampa Bay Rays': '33705',
    'Texas Rangers': '76011', 'Toronto Blue Jays': 'M5V', 'Washington Nationals': '20003'
}

PITCH_MAP = {'FF': 0, 'SL': 1, 'CH': 2, 'CB': 3, 'CU': 3, 'SI': 4, 'FC': 5, 'FS': 6, 'KC': 7, 'SP': 8, 'Unknown': 0}

def evaluate_team_hr_environment(temp_str, venue_name, opposing_pitcher_era):
    reasons = []
    try:
        temp_val = float(temp_str.replace('°C', '').strip())
        if temp_val < 13.0 and 'Dome' not in temp_str and 'Controlled' not in temp_str:
            reasons.append(f"Cold Weather ({temp_val}°C)")
    except: pass
    if opposing_pitcher_era < 3.20:
        reasons.append(f"Elite Opposing Pitcher (ERA {opposing_pitcher_era:.2f})")
    pitcher_parks = ['T-Mobile Park', 'Oracle Park', 'Comerica Park', 'PNC Park', 'Progressive Field', 'Kauffman Stadium', 'loanDepot park', 'Citi Field', 'Oakland Coliseum', 'Target Field', 'Busch Stadium']
    if any(park in venue_name for park in pitcher_parks):
        reasons.append(f"Pitcher-Friendly Park")
        
    if len(reasons) >= 2: return "⚠️ POOR", " | ".join(reasons), 0.85  
    elif len(reasons) == 1: return "⚠️ SUB-OPTIMAL", " | ".join(reasons), 0.95 
    else: return "✅ FAVORABLE", "Good Conditions", 1.05 

@st.cache_data(ttl=3600)
def fetch_team_records(target_date_str):
    team_records = {}
    season_year = int(target_date_str.split('-')[0])
    team_hr_map = {}
    try:
        url = f"https://statsapi.mlb.com/api/v1/teams/stats?season={season_year}&group=hitting&stats=season&sportIds=1"
        res = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=10).json()
        if 'stats' in res and len(res['stats']) > 0:
            for split in res['stats'][0].get('splits', []):
                tid = split.get('team', {}).get('id')
                hr = split.get('stat', {}).get('homeRuns', 0)
                if tid: team_hr_map[tid] = hr
    except: pass
    
    try:
        params = {'leagueId': '103,104', 'season': season_year, 'hydrate': 'record(splitRecords)'}
        res = statsapi.get('standings', params)
        for record in res.get('records', []):
            for team_rec in record.get('teamRecords', []):
                team_id = team_rec.get('team', {}).get('id')
                if not team_id: continue
                w = team_rec.get('leagueRecord', {}).get('wins', 0)
                l = team_rec.get('leagueRecord', {}).get('losses', 0)
                
                total_games = w + l
                win_pct = w / total_games if total_games > 0 else 0.500
                bullpen_era = max(2.50, min(5.50, 4.20 - ((win_pct - 0.500) * 5.0)))
                
                l10_w, l10_l = 0, 0
                for split in team_rec.get('records', {}).get('splitRecords', []):
                    if split.get('type') == 'lastTen':
                        l10_w, l10_l = split.get('wins', 0), split.get('losses', 0)
                        break
                hr_count = team_hr_map.get(team_id, "N/A")
                team_records[team_id] = {
                    'display': f"{w}-{l}, L10: {l10_w}-{l10_l}, HRs: {hr_count}",
                    'bullpen_era': round(bullpen_era, 2)
                }
    except: pass
    
    if not team_records:
        try:
            fallback_standings = statsapi.standings_data(leagueId="103,104", season=season_year)
            for div, data in fallback_standings.items():
                for team in data.get('teams', []):
                    tid = team.get('team_id')
                    w = team.get('w', 0)
                    l = team.get('l', 0)
                    total_games = w + l
                    win_pct = w / total_games if total_games > 0 else 0.500
                    bullpen_era = max(2.50, min(5.50, 4.20 - ((win_pct - 0.500) * 5.0)))
                    hr_count = team_hr_map.get(tid, "N/A")
                    if tid: team_records[tid] = {
                        'display': f"{w}-{l}, L10: N/A, HRs: {hr_count}",
                        'bullpen_era': round(bullpen_era, 2)
                    }
        except: pass
    return team_records

@st.cache_data(ttl=3600)
def get_daily_schedule(target_date_str):
    try: schedule = statsapi.schedule(date=target_date_str)
    except: return []
    records = fetch_team_records(target_date_str)
    games = []
    for game in schedule:
        try:
            utc_dt = datetime.datetime.strptime(game['game_datetime'], '%Y-%m-%dT%H:%M:%SZ')
            idt_time = (utc_dt + timedelta(hours=3)).strftime('%H:%M IDT')
        except: idt_time = "Time TBD"
        
        home_id, away_id = game['home_id'], game['away_id']
        home_data = records.get(home_id, {'display': '0-0, L10: 0-0, HRs: N/A', 'bullpen_era': 4.20})
        away_data = records.get(away_id, {'display': '0-0, L10: 0-0, HRs: N/A', 'bullpen_era': 4.20})
        
        home_pitcher = game.get('home_probable_pitcher', 'TBD')
        away_pitcher = game.get('away_probable_pitcher', 'TBD')
        if not home_pitcher: home_pitcher = 'TBD'
        if not away_pitcher: away_pitcher = 'TBD'
        
        games.append({
            'game_id': game['game_id'],
            'home_team': game['home_name'], 'away_team': game['away_name'],
            'home_rec': home_data['display'], 'away_rec': away_data['display'],
            'home_bullpen': home_data['bullpen_era'], 'away_bullpen': away_data['bullpen_era'],
            'home_id': home_id, 'away_id': away_id,     
            'home_pitcher': home_pitcher, 'away_pitcher': away_pitcher,
            'venue_id': game['venue_id'], 'venue_name': game['venue_name'], 'start_time': idt_time
        })
    return games

def get_lat_lon_from_zip(zip_code, country='us'):
    try:
        res = requests.get(f"http://api.zippopotam.us/{country}/{zip_code}").json()
        return float(res['places'][0]['latitude']), float(res['places'][0]['longitude'])
    except: return 0, 0

def fetch_live_weather(venue_id, venue_name, home_team):
    domes = ['Tropicana Field', 'loanDepot park', 'Chase Field', 'Globe Life Field', 'Rogers Centre', 'Minute Maid Park', 'American Family Field']
    if venue_name in domes: return 1.0, "Controlled 🌡️", "0 km/h", "🏟️ Dome"
    lat, lon = 0, 0
    try:
        venue_data = statsapi.get('venue', {'venueId': venue_id})['venues'][0]
        lat = venue_data['location']['defaultCoordinates']['latitude']
        lon = venue_data['location']['defaultCoordinates']['longitude']
    except:
        zip_code = MLB_ZIP_CODES.get(home_team, '00000')
        country = 'ca' if home_team == 'Toronto Blue Jays' else 'us'
        try:
            res = requests.get(f"http://api.zippopotam.us/{country}/{zip_code}").json()
            lat, lon = float(res['places'][0]['latitude']), float(res['places'][0]['longitude'])
        except: pass
    if lat == 0: return 1.0, "Unknown", "0 km/h", "❓"
    try:
        url = f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m,wind_speed_10m,weathercode&wind_speed_unit=kmh"
        response = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}).json()
        wind_kmh = response['current']['wind_speed_10m']
        temp = response['current']['temperature_2m']
        w_code = response['current']['weathercode']
        if w_code <= 1: icon = "☀️ Clear"
        elif w_code <= 3: icon = "⛅ Partly Cloudy"
        elif w_code <= 49: icon = "☁️ Overcast"
        elif w_code <= 69: icon = "🌧️ Rain"
        elif w_code <= 79: icon = "❄️ Snow"
        else: icon = "⛈️ Storm"
        
        if wind_kmh > 20: mod = 1.08; icon += " 💨"
        elif wind_kmh > 12: mod = 1.03
        elif temp < 10: mod = 0.96 
        else: mod = 1.0
        return mod, f"{temp}°C", f"{wind_kmh} km/h", icon
    except: return 1.0, "API Error", "0 km/h", "❓"

def fetch_pitcher_profile(last_name, first_name):
    era, p_hr_rate, p_k_rate = 4.00, 3.2, 22.5
    if last_name == 'TBD' or first_name == 'TBD':
        return pd.DataFrame(), era, p_hr_rate, p_k_rate
        
    try:
        player_dict = playerid_lookup(last_name, first_name)
        if player_dict.empty: return pd.DataFrame(), era, p_hr_rate, p_k_rate
        player_id = player_dict['key_mlbam'].values[0]
        
        try:
            stats = statsapi.player_stat_data(player_id, group="pitching", type="career")
            stat_block = stats.get('stats', [{}])[0].get('stats', {})
            era_str = str(stat_block.get('era', '4.00'))
            era = float(era_str) if era_str not in ['-.--', '*.**'] else 4.00
            if era == 0.0: era = 4.00 
            
            so = int(stat_block.get('strikeOuts', 0))
            hr = int(stat_block.get('homeRuns', 0))
            bf = int(stat_block.get('battersFaced', 1))
            if bf == 0: bf = 1
            
            p_k_rate = np.clip((so / bf) * 100, 5.0, 45.0)
            p_hr_rate = np.clip((hr / bf) * 100, 0.5, 8.0)
        except: pass

        end_date = datetime.datetime.today().strftime('%Y-%m-%d')
        start_date = (datetime.datetime.today() - timedelta(days=365)).strftime('%Y-%m-%d')
        raw = statcast_pitcher(start_date, end_date, player_id)
        if raw.empty: return pd.DataFrame(), era, p_hr_rate, p_k_rate
        
        if 'bb_type' in raw.columns:
            bip = raw[raw['description'] == 'hit_into_play']
            if len(bip) > 0:
                flyballs = bip[bip['bb_type'] == 'fly_ball']
                fb_rate = len(flyballs) / len(bip)
                p_hr_rate = p_hr_rate * np.clip(fb_rate / 0.25, 0.6, 1.4)
                
        if 'game_date' in raw.columns:
            unique_dates = raw['game_date'].unique()
            if len(unique_dates) > 0:
                last_3_dates = unique_dates[:3]
                recent_games = raw[raw['game_date'].isin(last_3_dates)]
                if len(recent_games) > 0:
                    recent_so = len(recent_games[recent_games['events'] == 'strikeout'])
                    recent_pa = len(recent_games[recent_games['events'].notna()])
                    if recent_pa > 0:
                        recent_k_rate = (recent_so / recent_pa) * 100.0
                        recent_k_rate = np.clip(recent_k_rate, 5.0, 35.0)
                        p_k_rate = (p_k_rate * 0.70) + (recent_k_rate * 0.30)
            
        mix = raw['pitch_type'].value_counts(normalize=True).reset_index()
        mix.columns = ['pitch_type', 'usage_percentage']
        return mix, era, p_hr_rate, p_k_rate
    except: return pd.DataFrame(), 4.00, 3.2, 22.5

def smart_statcast_batter(player_id, start_date, end_date):
    file_path = f"player_data/{player_id}.csv"
    os.makedirs("player_data", exist_ok=True)
    today = datetime.datetime.strptime(end_date, '%Y-%m-%d')
    if not os.path.exists(file_path):
        new_data = statcast_batter(start_date, end_date, player_id)
        if not new_data.empty: new_data.to_csv(file_path, index=False)
        return new_data
    try:
        local_df = pd.read_csv(file_path)
        if local_df.empty: return local_df
        last_saved_date_str = local_df['game_date'].max()
        last_saved_date = datetime.datetime.strptime(last_saved_date_str, '%Y-%m-%d')
        if last_saved_date >= today: return local_df
        delta_start = (last_saved_date + datetime.timedelta(days=1)).strftime('%Y-%m-%d')
        delta_data = statcast_batter(delta_start, end_date, player_id)
        if not delta_data.empty:
            updated_df = pd.concat([local_df, delta_data], ignore_index=True)
            updated_df.to_csv(file_path, index=False)
            return updated_df
        return local_df
    except Exception:
        new_data = statcast_batter(start_date, end_date, player_id)
        if not new_data.empty: new_data.to_csv(file_path, index=False)
        return new_data

def fetch_real_lineup_data(game_id, team_id, team_name, is_home, params):
    names, contact_values, best_pitches, b_hr_rates, b_k_rates, xbh_mods = [], [], [], [], [], []
    team_abbr = team_name.split(' ')[-1][:3].upper() 
    is_official = False
    
    try:
        hitters = []
        try:
            raw_box = statsapi.get('game_boxscore', {'gamePk': game_id})
            team_key = 'home' if is_home else 'away'
            team_node = raw_box.get('teams', {}).get(team_key, {})
            batting_order_ids = team_node.get('battingOrder', [])
            if len(batting_order_ids) >= 9:
                for pid in batting_order_ids[:9]:
                    player_info = team_node.get('players', {}).get(f'ID{pid}')
                    if player_info: hitters.append({'person': {'id': pid, 'fullName': player_info['person']['fullName']}})
                if len(hitters) == 9: is_official = True
        except: pass
            
        if not is_official:
            roster_data = statsapi.get('team_roster', {'teamId': team_id, 'rosterType': 'active'})['roster']
            hitters = [p for p in roster_data if p['position']['abbreviation'] != 'P']
            
        end_date = datetime.datetime.today().strftime('%Y-%m-%d')
        start_date = (datetime.datetime.today() - timedelta(days=45)).strftime('%Y-%m-%d')
        
        def process_hitter(hitter):
            name = hitter['person']['fullName']
            player_id = hitter['person']['id']
            full_name = f"{name} ({team_abbr})"
            xbh_mod = 1.0 
            
            try:
                stats = statsapi.player_stat_data(player_id, group="hitting", type="career")
                stat_block = stats.get('stats', [{}])[0].get('stats', {})
                avg_str = str(stat_block.get('avg', '.240'))
                avg = float(avg_str) if avg_str not in ['-.--', '*.**'] else 0.240
                so = int(stat_block.get('strikeOuts', 0))
                hr = int(stat_block.get('homeRuns', 0))
                pa = int(stat_block.get('plateAppearances', stat_block.get('atBats', 1)))
                if pa == 0: pa = 1
                b_k_rate = np.clip((so / pa) * 100, 5.0, 45.0)
                b_hr_rate = np.clip((hr / pa) * 100, 0.1, 10.0)
                avg_ratio = avg / 0.240
                contact_rv = 1.0 + ((avg_ratio - 1.0) * params['contact_regression']) 
            except: 
                contact_rv, b_k_rate, b_hr_rate = 1.0, 22.5, 3.2
            
            try:
                batter_data = smart_statcast_batter(player_id, start_date, end_date)
                if not batter_data.empty:
                    batter_data = batter_data.sort_values(by='game_date', ascending=False).reset_index(drop=True)
                    hits = batter_data[batter_data['events'].isin(['single', 'double', 'triple', 'home_run'])].copy()
                    if not hits.empty:
                        hits['weight'] = np.where(hits.index < 20, params['recent_weight'], np.where(hits.index < 40, params['mid_weight'], 1.0))
                        favorite_pitch = hits.groupby('pitch_type')['weight'].sum().idxmax()
                    else: favorite_pitch = 'FF' 
                    
                    unique_dates = batter_data['game_date'].unique()
                    if len(unique_dates) > 0:
                        last_5_dates = unique_dates[:5]
                        recent_games = batter_data[batter_data['game_date'].isin(last_5_dates)]
                        pa_events = ['strikeout', 'field_out', 'single', 'double', 'triple', 'home_run', 'walk', 'hit_by_pitch', 'force_out', 'grounded_into_dp', 'fielders_choice']
                        recent_pas = recent_games[recent_games['events'].isin(pa_events)]
                        
                        if len(recent_pas) > 0:
                            recent_bip = recent_games[recent_games['description'] == 'hit_into_play'].copy()
                            if len(recent_bip) > 0:
                                recent_bip['launch_speed'] = pd.to_numeric(recent_bip['launch_speed'], errors='coerce')
                                recent_bip['launch_angle'] = pd.to_numeric(recent_bip['launch_angle'], errors='coerce')
                                
                                # V96 FIX: Inverted the HR blend to prioritize active streaks over career baselines
                                hard_fb = recent_bip[(recent_bip['launch_speed'] >= 95) & (recent_bip['launch_angle'] >= 15)]
                                recent_barrel_rate = len(hard_fb) / len(recent_pas)
                                hr_multiplier = np.clip(recent_barrel_rate / 0.08, 0.5, 1.5) 
                                b_hr_rate = (b_hr_rate * 0.3) + ((b_hr_rate * hr_multiplier) * 0.7)
                                
                                hard_ld_fb = recent_bip[(recent_bip['launch_speed'] >= 90) & (recent_bip['launch_angle'].between(10, 35))]
                                recent_xbh_rate = len(hard_ld_fb) / len(recent_pas)
                                xbh_mod = np.clip(recent_xbh_rate / 0.07, 0.5, 1.5) 
                                
                            recent_hits = recent_pas[recent_pas['events'].isin(['single', 'double', 'triple', 'home_run'])]
                            if len(recent_pas) > 0:
                                recent_ba = len(recent_hits) / len(recent_pas)
                                contact_multiplier = np.clip(recent_ba / 0.240, 0.8, 1.25)
                                contact_rv = (contact_rv * 0.6) + ((contact_rv * contact_multiplier) * 0.4)
                            
                else: favorite_pitch = 'FF'
            except: favorite_pitch = 'FF'
            
            b_hr_rate = np.clip(b_hr_rate, 0.1, 15.0) 
            return {'name': full_name, 'contact_rv': round(contact_rv, 2), 'b_k_rate': round(b_k_rate, 2), 'b_hr_rate': round(b_hr_rate, 2), 'pitch': favorite_pitch, 'xbh_mod': round(xbh_mod, 2)}
        
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(process_hitter, hitters))
            
        if not is_official:
            results = sorted(results, key=lambda x: x['b_hr_rate'] + (x['contact_rv'] * x['xbh_mod']), reverse=True)[:9]
            
        for res in results:
            names.append(res['name'])
            contact_values.append(res['contact_rv'])
            b_hr_rates.append(res['b_hr_rate'])
            b_k_rates.append(res['b_k_rate'])
            best_pitches.append(res['pitch'])
            xbh_mods.append(res['xbh_mod'])
    except:
        names = [f"{team_name} Hitter {i} ({team_abbr})" for i in range(1, 10)]
        contact_values, b_hr_rates, b_k_rates, xbh_mods = [1.0] * 9, [3.2] * 9, [22.5] * 9, [1.0] * 9
        best_pitches = ['FF'] * 9
        is_official = False
        
    return pd.DataFrame({'batter_name': names, 'best_pitch': best_pitches, 'contact_rv': contact_values, 'b_hr_rate': b_hr_rates, 'b_k_rate': b_k_rates, 'xbh_mod': xbh_mods}), is_official

# ==========================================
# 2. NUMBA QUANTUM ENGINE (Compiled C-Code)
# ==========================================

def prepare_numba_arrays(pitcher_dict, batter_df):
    p_stats = np.array([pitcher_dict.get('era', 4.0), pitcher_dict.get('p_hr_rate', 3.2), pitcher_dict.get('p_k_rate', 22.5)], dtype=np.float64)
    
    mix_df = pitcher_dict['mix']
    if mix_df.empty:
        p_pitch_ids = np.array([0], dtype=np.int32)
        p_pitch_probs = np.array([1.0], dtype=np.float64)
    else:
        p_pitch_ids = np.array([PITCH_MAP.get(pt, 0) for pt in mix_df['pitch_type']], dtype=np.int32)
        p_pitch_probs = np.array(mix_df['usage_percentage'].tolist(), dtype=np.float64)
        
    lineup_matrix = np.zeros((9, 5), dtype=np.float64)
    for i, row in batter_df.iterrows():
        if i >= 9: break
        lineup_matrix[i, 0] = row.get('contact_rv', 1.0)
        lineup_matrix[i, 1] = row.get('b_hr_rate', 3.2)
        lineup_matrix[i, 2] = row.get('b_k_rate', 22.5)
        lineup_matrix[i, 3] = PITCH_MAP.get(row.get('best_pitch', 'FF'), 0)
        lineup_matrix[i, 4] = row.get('xbh_mod', 1.0)
        
    return p_stats, p_pitch_ids, p_pitch_probs, lineup_matrix

@njit
def simulate_at_bat_numba(p_stats, p_pitch_ids, p_pitch_probs, batter_stats, inning, weather_mod, env_mod, starter_active, bullpen_era, p_k_mod, params_array):
    if starter_active:
        p_era, p_hr_rate, p_k_rate = p_stats[0], p_stats[1], p_stats[2] * p_k_mod
    else:
        p_era = bullpen_era
        p_hr_rate = params_array[4] * params_array[3] * (bullpen_era / 4.20) 
        p_k_rate = params_array[9] * 1.05 * (4.20 / bullpen_era) * p_k_mod 
        
    c_rv, b_hr_rate, b_k_rate, best_pitch, xbh_mod = batter_stats[0], batter_stats[1], batter_stats[2], int(batter_stats[3]), batter_stats[4]
    
    roll_pitch = np.random.rand()
    cum_prob = 0.0
    pitch_thrown = p_pitch_ids[0]
    if starter_active:
        for i in range(len(p_pitch_probs)):
            cum_prob += p_pitch_probs[i]
            if roll_pitch < cum_prob:
                pitch_thrown = p_pitch_ids[i]
                break
                
    if pitch_thrown == best_pitch: c_rv *= params_array[1]
    else: c_rv *= params_array[2] 
        
    hr_prob = (b_hr_rate * p_hr_rate) / params_array[4]
    k_prob = (b_k_rate * p_k_rate) / params_array[9]
    
    hr_prob *= env_mod
    hr_prob *= weather_mod
    c_rv *= weather_mod
    
    if inning == 1:
        hr_prob *= params_array[0] 
        c_rv *= params_array[0]
        
    pitcher_mod = max(1.0 - params_array[14], min(1.0 + params_array[14], p_era / 4.00))
    c_rv *= pitcher_mod
    
    double_prob = params_array[5] * c_rv
    single_prob = params_array[7] * c_rv 
    triple_prob = params_array[6] * c_rv
    walk_prob = params_array[8]
    
    double_shift = double_prob * (xbh_mod - 1.0)
    triple_shift = triple_prob * (xbh_mod - 1.0)
    double_prob += double_shift
    triple_prob += triple_shift
    single_prob -= (double_shift + triple_shift)
    
    hr_base_prob = (params_array[4] * p_hr_rate) / params_array[4]
    hr_diff = hr_prob - (hr_base_prob * env_mod * weather_mod)
    if hr_diff > 0: single_prob -= hr_diff
    if single_prob < 0: single_prob = 0.0
    
    total_hit = hr_prob + double_prob + single_prob + triple_prob + walk_prob
    
    eff_obp_cap = params_array[15] * (params_array[0] if inning == 1 else 1.0)
    
    if total_hit > eff_obp_cap: 
        scale = eff_obp_cap / total_hit
        hr_prob *= scale
        double_prob *= scale
        single_prob *= scale
        triple_prob *= scale
        walk_prob *= scale
        
    out_prob = 100.0 - (hr_prob + double_prob + single_prob + triple_prob + walk_prob)
    if k_prob > out_prob * 0.95: k_prob = out_prob * 0.95
    field_out_prob = max(0.0, out_prob - k_prob)
    
    probs = np.array([field_out_prob, single_prob, double_prob, triple_prob, hr_prob, walk_prob, k_prob])
    cum_probs = np.cumsum(probs)
    roll = np.random.rand() * 100.0
    
    for i in range(7):
        if roll < cum_probs[i]: return i
    return 0

@njit
def play_inning_numba(p_stats, p_pitch_ids, p_pitch_probs, lineup_matrix, current_idx, inning, weather_mod, env_mod, starter_active, bullpen_era, p_k_mod, params_array):
    outs, runs, inning_k = 0, 0, 0
    b1 = b2 = b3 = False
    inn_hr = np.zeros(9, dtype=np.int32)
    inn_tb = np.zeros(9, dtype=np.int32)
    
    while outs < 3:
        batter_stats = lineup_matrix[current_idx]
        outcome = simulate_at_bat_numba(p_stats, p_pitch_ids, p_pitch_probs, batter_stats, inning, weather_mod, env_mod, starter_active, bullpen_era, p_k_mod, params_array)
        
        if outcome == 0: outs += 1
        elif outcome == 6: 
            outs += 1
            if starter_active: inning_k += 1 
        elif outcome == 5: 
            if b1 and b2 and b3: runs += 1
            elif b1 and b2: b3 = True
            elif b1: b2 = True
            b1 = True
        elif outcome == 1: 
            if b3: runs += 1; b3 = False
            if b2: b3 = True; b2 = False
            if b1: b2 = True
            b1 = True
            inn_tb[current_idx] += 1
        elif outcome == 2: 
            if b3: runs += 1; b3 = False
            if b2: runs += 1; b2 = False
            if b1: b3 = True; b1 = False
            b2 = True
            inn_tb[current_idx] += 2
        elif outcome == 3: 
            if b3: runs += 1; b3 = False
            if b2: runs += 1; b2 = False
            if b1: runs += 1; b1 = False
            b3 = True
            inn_tb[current_idx] += 3
        elif outcome == 4: 
            runs += (1 if b3 else 0) + (1 if b2 else 0) + (1 if b1 else 0) + 1
            b3 = b2 = b1 = False
            inn_tb[current_idx] += 4
            inn_hr[current_idx] += 1
            
        current_idx = (current_idx + 1) % 9
    return runs, current_idx, inn_hr, inn_tb, inning_k

@njit
def run_monte_carlo_numba(p_stats, p_pitch_ids, p_pitch_probs, lineup_matrix, weather_mod, env_modifier, bullpen_era, is_facing_home, params_array):
    num_sims = 5000
    total_runs_array = np.zeros(num_sims, dtype=np.int32)
    f5_runs_array = np.zeros(num_sims, dtype=np.int32)
    ks_array = np.zeros(num_sims, dtype=np.int32)
    yrfi_count = 0
    games_with_hr = np.zeros(9, dtype=np.int32)
    games_with_2tb = np.zeros(9, dtype=np.int32)
    p_k_mod = 1.05 if is_facing_home else 1.0
    
    for sim in range(num_sims):
        game_score, current_idx, sim_ks = 0, 0, 0
        starter_active = True
        sim_hr, sim_tb = np.zeros(9, dtype=np.int32), np.zeros(9, dtype=np.int32)
        
        for inning in range(1, 10):
            if inning > 6 or game_score >= 4 or (inning == 6 and game_score >= 2): starter_active = False
            runs, current_idx, inn_hr, inn_tb, inn_k = play_inning_numba(p_stats, p_pitch_ids, p_pitch_probs, lineup_matrix, current_idx, inning, weather_mod, env_modifier, starter_active, bullpen_era, p_k_mod, params_array)
            game_score += runs
            sim_ks += inn_k
            for i in range(9):
                sim_hr[i] += inn_hr[i]
                sim_tb[i] += inn_tb[i]
            if inning == 1 and runs > 0: yrfi_count += 1
            if inning == 5: f5_runs_array[sim] = game_score
                
        total_runs_array[sim] = game_score
        ks_array[sim] = sim_ks
        for i in range(9):
            if sim_hr[i] > 0: games_with_hr[i] += 1
            if sim_tb[i] >= 2: games_with_2tb[i] += 1
            
    return total_runs_array, f5_runs_array, ks_array, yrfi_count, games_with_hr, games_with_2tb

# ==========================================
# 3. ACTUAL RESULTS FETCHER (MODEL GRADING)
# ==========================================

def get_actual_game_results(game_id):
    try:
        sched = statsapi.schedule(game_id=game_id)
        if not sched or sched[0]['status'] not in ['Final', 'Completed Early', 'Game Over']: return None

        game_info = sched[0]
        away_team = game_info.get('away_name', 'Away')
        home_team = game_info.get('home_name', 'Home')
        away_runs = game_info.get('away_score', 0)
        home_runs = game_info.get('home_score', 0)
        actual_total_runs = away_runs + home_runs

        if home_runs > away_runs: actual_winner = f"{home_team} ({home_runs}-{away_runs})"
        else: actual_winner = f"{away_team} ({away_runs}-{home_runs})"

        linescore = statsapi.get('game_linescore', {'gamePk': game_id})
        innings = linescore.get('innings', [])
        f5_away = sum(inn.get('away', {}).get('runs', 0) for inn in innings[:5])
        f5_home = sum(inn.get('home', {}).get('runs', 0) for inn in innings[:5])
        
        if f5_home > f5_away: actual_f5_team = home_team
        elif f5_away > f5_home: actual_f5_team = away_team
        else: actual_f5_team = "Tie"
        actual_f5_winner = f"{actual_f5_team} ({f5_away}-{f5_home})"

        if len(innings) > 0: inning_1_away, inning_1_home, inning_1_total = innings[0].get('away', {}).get('runs', 0), innings[0].get('home', {}).get('runs', 0), innings[0].get('away', {}).get('runs', 0) + innings[0].get('home', {}).get('runs', 0)
        else: inning_1_away, inning_1_home, inning_1_total = 0, 0, 0

        yrfi = "✅ YES" if inning_1_total > 0 else "❌ NO"
        yrfi_score = f"{inning_1_away} - {inning_1_home}"

        raw_box = statsapi.get('game_boxscore', {'gamePk': game_id})
        actual_hrs, actual_2tb = [], []
        for team_key in ['away', 'home']:
            for pid, pdata in raw_box.get('teams', {}).get(team_key, {}).get('players', {}).items():
                stats = pdata.get('stats', {}).get('batting', {})
                if not stats: continue
                name = pdata.get('person', {}).get('fullName', 'Unknown')
                hr, tb = stats.get('homeRuns', 0), stats.get('totalBases', 0)
                if hr > 0: actual_hrs.append(f"{name} ({hr} HR)")
                if tb >= 2: actual_2tb.append(f"{name} ({tb} TB)")
                
        away_actual_ks, home_actual_ks = 0, 0
        try:
            away_pitchers = raw_box.get('teams', {}).get('away', {}).get('pitchers', [])
            home_pitchers = raw_box.get('teams', {}).get('home', {}).get('pitchers', [])
            if away_pitchers: away_actual_ks = raw_box['teams']['away']['players'].get(f"ID{away_pitchers[0]}", {}).get('stats', {}).get('pitching', {}).get('strikeOuts', 0)
            if home_pitchers: home_actual_ks = raw_box['teams']['home']['players'].get(f"ID{home_pitchers[0]}", {}).get('stats', {}).get('pitching', {}).get('strikeOuts', 0)
        except: pass

        return {
            "winner": actual_winner, "f5_winner": actual_f5_winner,
            "total_runs": actual_total_runs, "yrfi": f"{yrfi} ({yrfi_score})",
            "hrs": ", ".join(actual_hrs) if actual_hrs else "None",
            "tb": ", ".join(actual_2tb) if actual_2tb else "None",
            "away_pitcher_ks": away_actual_ks, "home_pitcher_ks": home_actual_ks
        }
    except: return None

# ==========================================
# 4. STREAMLIT WEB DASHBOARD (UNIFIED)
# ==========================================

st.sidebar.header("🎛️ Quant Parameter Dashboard")
st.sidebar.markdown("Fine-tune the engine's mathematical weights before running.")

st.sidebar.subheader("Matchup Multipliers")
param_yrfi_boost = st.sidebar.slider("1st Inning (YRFI) Top-of-Order Boost", 1.0, 1.5, 1.15, 0.05, help="Applies a flat boost to the 1st inning to simulate the 1-2-3 hitters guaranteed appearance.")
param_fav_pitch = st.sidebar.slider("Favorite Pitch Multiplier", 1.0, 2.0, 1.15, 0.05, help="Stat multiplier if batter faces the pitch they crush.")
param_wrong_pitch = st.sidebar.slider("Wrong Pitch Multiplier", 0.5, 1.0, 0.90, 0.05, help="Stat penalty if batter faces a pitch they struggle against.")
param_bullpen = st.sidebar.slider("Bullpen Fatigue Multiplier", 1.0, 1.5, 1.05, 0.05, help="Boost applied to hitters in innings 7-9 against tired relievers.")

st.sidebar.subheader("League Baseline Probabilities")
param_hr_base = st.sidebar.slider("League HR Baseline (%)", 1.0, 6.0, 3.2, 0.1, help="MLB Average is ~3.2%. Used as Log5 denominator.")
param_k_base = st.sidebar.slider("League K Baseline (%)", 10.0, 30.0, 22.5, 0.5, help="MLB Average is ~22.5%. Used as Log5 denominator.")
param_double_base = st.sidebar.slider("Base Double Probability (%)", 2.0, 8.0, 4.5, 0.1, help="MLB Average is ~4.5%.")
param_triple_base = st.sidebar.slider("Base Triple Probability (%)", 0.1, 3.0, 0.5, 0.1, help="MLB Average is ~0.5%.")
param_single_base = st.sidebar.slider("Base Single Probability (%)", 10.0, 25.0, 14.5, 0.5, help="MLB Average is ~14.5%.")
param_walk_base = st.sidebar.slider("Base Walk Probability (%)", 5.0, 15.0, 8.5, 0.5, help="MLB Average is ~8.5%.")

st.sidebar.subheader("Recency Bias Weights")
param_recent_wt = st.sidebar.slider("Last 20 Pitches Weight", 1.0, 3.0, 2.0, 0.1)
param_mid_wt = st.sidebar.slider("Pitches 20-40 Weight", 1.0, 2.0, 1.5, 0.1)

st.sidebar.subheader("Advanced Sabermetrics")
param_contact_reg = st.sidebar.slider("Contact Translation Weight (%)", 5.0, 50.0, 15.0, 1.0) / 100.0
param_pitcher_impact = st.sidebar.slider("Pitcher ERA Max Impact (%)", 1.0, 45.0, 15.0, 1.0) / 100.0
param_obp_cap = st.sidebar.slider("Elite OBP Hard Cap (%)", 20.0, 60.0, 34.0, 1.0)

st.sidebar.markdown("---")
force_refresh = st.sidebar.checkbox("Force Fresh Download (Ignore Cache)")

engine_params = {
    'yrfi_boost': param_yrfi_boost, 'fav_pitch_mult': param_fav_pitch, 'wrong_pitch_mult': param_wrong_pitch,
    'bullpen_mult': param_bullpen, 'hr_base': param_hr_base, 'double_base': param_double_base, 
    'triple_base': param_triple_base, 'single_base': param_single_base, 'walk_base': param_walk_base,
    'k_base': param_k_base, 'recent_weight': param_recent_wt, 'mid_weight': param_mid_wt,
    'contact_regression': param_contact_reg, 'pitcher_impact': param_pitcher_impact, 'obp_cap': param_obp_cap
}

st.title("⚾ MLB Quant Dashboard - v96")
st.markdown(f"**Last Code Edit:** `{LAST_EDIT_SOURCE}` | Numba Engine | V96 Winner EV Thresholds")

st.header("🔴 Live Predictions Engine", divider="red")

date_col, empty_col = st.columns([3, 7])
with date_col: target_date = st.date_input("Select Game Date", datetime.date.today())
target_date_str = target_date.strftime('%Y-%m-%d')

todays_games = get_daily_schedule(target_date_str)
history = load_history()
daily_record = next((r for r in history if r.get('date') == target_date_str), None)
if not daily_record: daily_record = {"date": target_date_str, "timestamp": "", "games": []}

st.markdown("### 📋 Daily Slate & Selective Simulation")
def toggle_all():
    for g in todays_games: st.session_state[f"sim_chk_{g['game_id']}"] = st.session_state.select_all_chk

st.checkbox("☑️ Select All Games for Simulation", key="select_all_chk", on_change=toggle_all)
selected_games_for_run = []

if not todays_games: st.warning("No scheduled games with probable pitchers found for this date.")
else:
    for g in todays_games:
        existing_sim = next((x for x in daily_record['games'] if x['game_id'] == g['game_id']), None)
        last_sim_time = existing_sim.get('last_simulated', 'Not Simulated') if existing_sim else 'Not Simulated'
        status_icon = "🟢" if last_sim_time != 'Not Simulated' else "⚪"
        col_chk, col_info = st.columns([1, 9])
        with col_chk:
            if st.checkbox("Simulate", key=f"sim_chk_{g['game_id']}"): selected_games_for_run.append(g)
        with col_info:
            st.write(f"{status_icon} **{g['away_team']}** `{g['away_rec']}` **@ {g['home_team']}** `{g['home_rec']}` | ⏰ {g['start_time']} | 🔄 Last Sim: `{last_sim_time}`")

st.write("")
run_col, stop_col = st.columns([4, 4])

with run_col: 
    if st.button("🚀 Run Selected Simulations", use_container_width=True):
        if not selected_games_for_run: st.error("⚠️ Please check at least one game above to simulate!")
        else:
            st.session_state.app_state = 'running'
            st.session_state.run_payload = {"date": target_date_str, "selected_games": selected_games_for_run, "start_time": time.time(), "run_environment": get_runtime_environment()}
            if force_refresh: st.cache_data.clear(); pybaseball.cache.purge()
            
with stop_col: 
    if st.button("🛑 Stop Process", use_container_width=True): st.session_state.app_state = 'stopped'

# --- THE MAIN EXECUTION LOOP ---
if st.session_state.app_state == 'running':
    st.info(f"⚙️ **Engine is currently executing on:** `{st.session_state.run_payload['run_environment']}`")
    games_to_run = st.session_state.run_payload["selected_games"]
    total_games = len(games_to_run)
    global_progress_text = st.empty()
    local_time_str = (datetime.datetime.utcnow() + timedelta(hours=3)).strftime('%H:%M IDT')
    
    params_array = np.array([
        engine_params['yrfi_boost'], engine_params['fav_pitch_mult'], engine_params['wrong_pitch_mult'],
        engine_params['bullpen_mult'], engine_params['hr_base'], engine_params['double_base'], 
        engine_params['triple_base'], engine_params['single_base'], engine_params['walk_base'],
        engine_params['k_base'], engine_params['recent_weight'], engine_params['mid_weight'],
        engine_params['contact_regression'], 0.0, engine_params['pitcher_impact'], engine_params['obp_cap']
    ], dtype=np.float64)
    
    for index, game in enumerate(games_to_run):
        if st.session_state.app_state == 'stopped': break
        global_progress_text.info(f"⚙️ **Processing Game {index + 1} of {total_games}:** {game['away_team']} @ {game['home_team']}...")
        
        try:
            with st.container():
                st.markdown(f"### {game['away_team']} ({game['away_rec'].split(',')[0]}) @ {game['home_team']} ({game['home_rec'].split(',')[0]}) - `{game['start_time']}`")
                meta_c1, meta_c2, meta_c3 = st.columns([2, 1, 2])
                with meta_c1: st.markdown(f"**🏟️ Venue:** {game['venue_name']}")
                with meta_c2:
                    mod, temp, wind_kmh, icon = fetch_live_weather(game['venue_id'], game['venue_name'], game['home_team'])
                    st.metric(f"Weather: {icon}", f"{temp} | {wind_kmh}", f"Modifier: {mod}x")
                with meta_c3: st.markdown(f"**Away Starter:** {game['away_pitcher']}<br>**Home Starter:** {game['home_pitcher']}", unsafe_allow_html=True)
                
                status_text = st.empty()
                progress_bar = st.progress(0.0)
                status_text.text("Fetching Statcast Data & Scraping Rosters...")
                
                away_p_split, home_p_split = game['away_pitcher'].split(' '), game['home_pitcher'].split(' ')
                with concurrent.futures.ThreadPoolExecutor() as executor:
                    f_away_p = executor.submit(fetch_pitcher_profile, away_p_split[-1], away_p_split[0])
                    f_home_p = executor.submit(fetch_pitcher_profile, home_p_split[-1], home_p_split[0])
                    f_away_l = executor.submit(fetch_real_lineup_data, game['game_id'], game['away_id'], game['away_team'], False, engine_params)
                    f_home_l = executor.submit(fetch_real_lineup_data, game['game_id'], game['home_id'], game['home_team'], True, engine_params)
                    
                    a_mix, a_era, a_hr_r, a_k_r = f_away_p.result()
                    h_mix, h_era, h_hr_r, h_k_r = f_home_p.result()
                    a_p_data = {'mix': a_mix, 'era': a_era, 'p_hr_rate': a_hr_r, 'p_k_rate': a_k_r}
                    h_p_data = {'mix': h_mix, 'era': h_era, 'p_hr_rate': h_hr_r, 'p_k_rate': h_k_r}
                    
                    away_lineup, a_off = f_away_l.result()
                    home_lineup, h_off = f_home_l.result()
                    
                lineup_status = "✅ Official Lineups" if a_off and h_off else "🔮 Projected Lineups"
                away_hr_status, away_hr_reasons, away_env_modifier = evaluate_team_hr_environment(temp, game['venue_name'], h_era)
                home_hr_status, home_hr_reasons, home_env_modifier = evaluate_team_hr_environment(temp, game['venue_name'], a_era)

                away_p_stats, away_p_ids, away_p_probs, away_matrix = prepare_numba_arrays(a_p_data, away_lineup)
                home_p_stats, home_p_ids, home_p_probs, home_matrix = prepare_numba_arrays(h_p_data, home_lineup)

                progress_bar.progress(0.4)
                status_text.text("Running 10,000 Numba C-Simulations...")
                
                with concurrent.futures.ThreadPoolExecutor() as executor:
                    f_a_res = executor.submit(run_monte_carlo_numba, home_p_stats, home_p_ids, home_p_probs, away_matrix, mod, away_env_modifier, game['home_bullpen'], True, params_array)
                    f_h_res = executor.submit(run_monte_carlo_numba, away_p_stats, away_p_ids, away_p_probs, home_matrix, mod, home_env_modifier, game['away_bullpen'], False, params_array)
                    away_runs, away_f5, away_ks, away_yrfi, away_hr, away_tb = f_a_res.result()
                    home_runs, home_f5, home_ks, home_yrfi, home_hr, home_tb = f_h_res.result()
                
                progress_bar.progress(1.0)
                status_text.text("Simulation Complete.")
                
                home_exp, away_exp = np.mean(home_runs), np.mean(away_runs)
                raw_margin = abs(home_exp - away_exp)
                spread = max(1.0, round(raw_margin * 2) / 2)
                
                a_k_target, a_k_prob = 1, 0.0
                for k_val in range(20, 0, -1):
                    prob = np.sum(home_ks >= k_val) / 5000.0 * 100.0
                    if prob >= 55.0:
                        a_k_target, a_k_prob = k_val, prob
                        break
                if a_k_target == 0:
                    a_k_target = 1
                    a_k_prob = np.sum(home_ks >= 1) / 5000.0 * 100.0
                    
                h_k_target, h_k_prob = 1, 0.0
                for k_val in range(20, 0, -1):
                    prob = np.sum(away_ks >= k_val) / 5000.0 * 100.0
                    if prob >= 55.0:
                        h_k_target, h_k_prob = k_val, prob
                        break
                if h_k_target == 0:
                    h_k_target = 1
                    h_k_prob = np.sum(away_ks >= 1) / 5000.0 * 100.0

                away_5k_rec = f"YES {a_k_target}+ Ks"
                home_5k_rec = f"YES {h_k_target}+ Ks"
                
                h_wins, a_wins, t_wins = np.sum(home_runs > away_runs), np.sum(away_runs > home_runs), np.sum(home_runs == away_runs)
                home_win_prob, away_win_prob = ((h_wins + (0.5 * t_wins)) / 5000) * 100, ((a_wins + (0.5 * t_wins)) / 5000) * 100
                
                # V96 FIX: Strict EV boundaries for Macro Markets (PASS on Coin Flips)
                if home_win_prob > 53.0: winner, win_prob = game['home_team'], home_win_prob
                elif away_win_prob > 53.0: winner, win_prob = game['away_team'], away_win_prob
                else: winner, win_prob = "PASS (Coin Flip)", max(home_win_prob, away_win_prob)
                
                f5_h_wins, f5_a_wins, f5_t_wins = np.sum(home_f5 > away_f5), np.sum(away_f5 > home_f5), np.sum(home_f5 == away_f5)
                f5_h_prob, f5_a_prob = (f5_h_wins / 5000) * 100, (f5_a_wins / 5000) * 100
                
                if f5_h_prob > 53.0: f5_pred, f5_prob = game['home_team'], f5_h_prob
                elif f5_a_prob > 53.0: f5_pred, f5_prob = game['away_team'], f5_a_prob
                else: f5_pred, f5_prob = "PASS (Coin Flip)", max(f5_h_prob, f5_a_prob)

                a_yrfi_prob, h_yrfi_prob = (away_yrfi / 5000.0) * 100.0, (home_yrfi / 5000.0) * 100.0
                true_yrfi = (a_yrfi_prob + h_yrfi_prob) - ((a_yrfi_prob * h_yrfi_prob) / 100)
                
                if true_yrfi >= 55.0: yrfi_rec = "YRFI"
                elif true_yrfi <= 45.0: yrfi_rec = "NRFI"
                else: yrfi_rec = "PASS"

                HR_BETTABILITY_THRESHOLD = 28.0
                TB_BETTABILITY_THRESHOLD = 55.0

                all_hr, all_tb = {}, {}
                for i in range(9):
                    a_name, h_name = away_lineup['batter_name'].iloc[i], home_lineup['batter_name'].iloc[i]
                    a_hr_p, h_hr_p = (away_hr[i] / 50.0), (home_hr[i] / 50.0)
                    a_tb_p, h_tb_p = (away_tb[i] / 50.0), (home_tb[i] / 50.0)
                    
                    if a_hr_p >= HR_BETTABILITY_THRESHOLD: all_hr[a_name] = a_hr_p
                    if h_hr_p >= HR_BETTABILITY_THRESHOLD: all_hr[h_name] = h_hr_p
                    if a_tb_p >= TB_BETTABILITY_THRESHOLD: all_tb[a_name] = a_tb_p
                    if h_tb_p >= TB_BETTABILITY_THRESHOLD: all_tb[h_name] = h_tb_p

                top_hr = sorted(all_hr.items(), key=lambda x: x[1], reverse=True)[:6]
                top_tb = sorted(all_tb.items(), key=lambda x: x[1], reverse=True)[:6]
                
                new_game_data = {
                    "game_id": game['game_id'], "matchup": f"{game['away_team']} @ {game['home_team']}",
                    "away_pitcher": game['away_pitcher'], "away_5k_rec": f"{away_5k_rec} ({a_k_prob:.1f}%)",
                    "home_pitcher": game['home_pitcher'], "home_5k_rec": f"{home_5k_rec} ({h_k_prob:.1f}%)",
                    "winner": winner, "win_prob": win_prob, "spread": spread, "total_runs": round(home_exp + away_exp, 1),
                    "f5_pred": f5_pred, "f5_prob": f5_prob, "yrfi": true_yrfi, "yrfi_rec": yrfi_rec, "top_hr": top_hr, "top_tb": top_tb,
                    "lineup_status": lineup_status, "last_simulated": local_time_str,
                    "away_hr_env": f"{away_hr_status}: {away_hr_reasons}", "home_hr_env": f"{home_hr_status}: {home_hr_reasons}"
                }
                
                existing_idx = next((i for i, x in enumerate(daily_record['games']) if x['game_id'] == game['game_id']), None)
                if existing_idx is not None:
                    if daily_record['games'][existing_idx].get('actual_results'): new_game_data['actual_results'] = daily_record['games'][existing_idx]['actual_results']
                    daily_record['games'][existing_idx] = new_game_data
                else: daily_record['games'].append(new_game_data)
                
                save_daily_master(daily_record)
                
                res_c1, res_c2, res_c3 = st.columns(3)
                with res_c1:
                    st.success(f"**Predicted Winner:** {winner} ({win_prob:.1f}%)")
                    st.write(f"**F5 Winner:** {f5_pred} ({f5_prob:.1f}%)")
                    st.write(f"**Total Expected Runs:** {round(home_exp + away_exp, 1)}")
                    st.write(f"**YRFI Prob:** {round(true_yrfi, 1)}% (👉 **Play: {yrfi_rec}**)")
                    st.write(f"**K Props:** {game['away_pitcher'].split(' ')[-1]} `{away_5k_rec} ({a_k_prob:.1f}%)` | {game['home_pitcher'].split(' ')[-1]} `{home_5k_rec} ({h_k_prob:.1f}%)`")
                with res_c2:
                    st.warning("**💥 Top HR Targets**")
                    if top_hr:
                        for p, prob in top_hr: st.write(f"{p}: `{prob:.1f}%`")
                    else: st.write("`NONE (Skipping Game)`")
                with res_c3:
                    st.info("**🏃 Top 2+ TB Targets**")
                    if top_tb:
                        for p, prob in top_tb: st.write(f"{p}: `{prob:.1f}%`")
                    else: st.write("`NONE (Skipping Game)`")
                st.divider()
        except Exception as e: st.warning(f"⚠️ Game Skipped: {e}"); continue
            
    if st.session_state.app_state == 'running':
        st.session_state.app_state = 'completed'
        st.rerun()

if st.session_state.app_state in ['completed', 'stopped']:
    history = load_history()
    payload = st.session_state.run_payload
    daily_record = next((r for r in history if r.get('date') == payload.get('date')), None)
    
    run_end_time = time.time()
    exec_duration = run_end_time - payload.get('start_time', run_end_time)
    exec_mins, exec_secs = int(exec_duration // 60), int(exec_duration % 60)
    
    if st.session_state.app_state == 'stopped': st.warning(f"🛑 **Process Manually Stopped!** (⏱️ Time: {exec_mins}m {exec_secs}s)")
    else: st.success(f"✅ **Simulations successfully committed! (⏱️ Execution Time: {exec_mins}m {exec_secs}s)**")
        
    master_hr_list, master_tb_list, master_game_list = [], [], []
    
    if daily_record and daily_record.get('games'):
        for g in daily_record['games']:
            if 'winner' not in g: continue
            
            matchup_name = g.get('matchup', 'Unknown Matchup')
            a_env, h_env = g.get('away_hr_env', ''), g.get('home_hr_env', '')
            
            master_game_list.append({
                'Matchup': matchup_name, 
                'Pitchers': f"{g.get('away_pitcher', 'TBD')} vs {g.get('home_pitcher', 'TBD')}",
                'Away K Prop': g.get('away_5k_rec', 'N/A'), 'Home K Prop': g.get('home_5k_rec', 'N/A'),
                'YRFI Prob': g.get('yrfi', 0.0), 'YRFI Rec': g.get('yrfi_rec', 'N/A'),
                'Winner': g.get('winner', 'N/A'), 'Win Prob': g.get('win_prob', 0.0), 'F5 Winner': g.get('f5_pred', 'N/A'), 
                'Spread': g.get('spread', 1.0), 'Last Sim': g.get('last_simulated', 'N/A')
            })
            
            for p, prob in g.get('top_hr', []): 
                env_to_check = a_env if f"({matchup_name.split(' @ ')[0][:3]})" in p else h_env
                if "POOR" not in env_to_check and "SUB-OPTIMAL" not in env_to_check: master_hr_list.append({'Player': p, 'HR Prob': prob, 'Game': matchup_name.split(' @ ')[0][:3] + "@" + matchup_name.split(' @ ')[-1][:3]})
                    
            for p, prob in g.get('top_tb', []): master_tb_list.append({'Player': p, '2+ TB Prob': prob, 'Game': matchup_name.split(' @ ')[0][:3] + "@" + matchup_name.split(' @ ')[-1][:3]})
                
        hr_df = pd.DataFrame(master_hr_list).sort_values(by='HR Prob', ascending=False).head(10).reset_index(drop=True) if master_hr_list else pd.DataFrame([{"Message": "No safe HR targets today."}])
        tb_df = pd.DataFrame(master_tb_list).sort_values(by='2+ TB Prob', ascending=False).head(10).reset_index(drop=True) if master_tb_list else pd.DataFrame([{"Message": "No safe TB targets today."}])
        games_df = pd.DataFrame(master_game_list).sort_values(by='YRFI Prob', ascending=False).reset_index(drop=True) if master_game_list else pd.DataFrame()
        
        st.header(f"🏆 Full Slate Summary: {payload.get('date', 'Today')}")
        colA, colB = st.columns(2)
        
        with colA: 
            if 'HR Prob' in hr_df.columns:
                st.dataframe(hr_df.style.format({'HR Prob': '{:.1f}%'}))
            else:
                st.dataframe(hr_df)
                
        with colB: 
            if '2+ TB Prob' in tb_df.columns:
                st.dataframe(tb_df.style.format({'2+ TB Prob': '{:.1f}%'}))
            else:
                st.dataframe(tb_df)
                
        if not games_df.empty: 
            st.dataframe(games_df.style.format({'YRFI Prob': '{:.1f}%'}))
        st.divider()
        
        try:
            local_time_str = (datetime.datetime.utcnow() + timedelta(hours=3)).strftime('%Y-%m-%d %H:%M IDT')
            tg_msg = f"⚾ <b>MLB Quant Engine Update (v96)</b>\n🖥️ <b>Server:</b> {payload.get('run_environment', 'Unknown')}\n📅 <b>Date:</b> {payload.get('date', 'Unknown')}\n⏱️ <b>Batch Execution:</b> {exec_mins}m {exec_secs}s\n\n📋 <b>FULL DAILY SLATE STATUS:</b>\n\n"
            
            for sched_game in get_daily_schedule(payload.get('date')):
                sim_data = next((x for x in daily_record['games'] if x.get('game_id') == sched_game.get('game_id')), None)
                away_t, home_t = sched_game.get('away_team', 'Away'), sched_game.get('home_team', 'Home')
                away_p, home_p = sched_game.get('away_pitcher', 'TBD').split(' ')[-1], sched_game.get('home_pitcher', 'TBD').split(' ')[-1]
                
                tg_msg += f"▪️ <b>{away_t} @ {home_t}</b>\n"
                if sim_data and 'winner' in sim_data:
                    tg_msg += f"   📋 <b>Lineups:</b> {sim_data.get('lineup_status', 'Unknown')}\n"
                    tg_msg += f"   ⚾ <b>K Props:</b> {away_p} {sim_data.get('away_5k_rec', 'N/A')} | {home_p} {sim_data.get('home_5k_rec', 'N/A')}\n"
                    tg_msg += f"   🏆 Winner: {sim_data.get('winner', 'N/A')} ({sim_data.get('win_prob', 0.0):.1f}%)\n"
                    tg_msg += f"   ⚾ {sim_data.get('total_runs', 'N/A')} Runs | {sim_data.get('yrfi_rec', 'NRFI')}: {sim_data.get('yrfi', 0.0):.1f}%\n"
                    
                    a_env, h_env = sim_data.get('away_hr_env', ''), sim_data.get('home_hr_env', '')
                    if "POOR" in a_env or "POOR" in h_env: tg_msg += f"   🏟️ ⚠️ POOR ENV DETECTED\n"
                    
                    if sim_data.get('top_hr'):
                        safe_hrs = []
                        for p, prob in sim_data.get('top_hr', []):
                            try:
                                team_abbr = p.split('(')[-1].replace(')', '').strip()
                                env_to_check = a_env if team_abbr in away_t.upper() else h_env
                            except:
                                env_to_check = "POOR"
                                
                            if "POOR" not in env_to_check:
                                safe_hrs.append(f"{p} ({prob:.1f}%)")
                                
                        if safe_hrs: tg_msg += f"   ✅ <b>WORTHY HR BETS:</b> {', '.join(safe_hrs)}\n"
                        else: tg_msg += f"   🛑 <b>HR BETS:</b> NOT RECOMMENDED (Poor Environment)\n"
                    else: tg_msg += f"   🛑 <b>HR BETS:</b> NONE\n"
                            
                    if sim_data.get('top_tb'):
                        tb_strs = []
                        for p, prob in sim_data.get('top_tb', []):
                            tb_strs.append(f"{p} ({prob:.1f}%)")
                        tg_msg += f"   🏃 <b>2+ TB Targets:</b> {', '.join(tb_strs)}\n"
                    else: tg_msg += f"   🏃 <b>2+ TB Targets:</b> NONE\n"
                else: tg_msg += f"   ⚠️ <i>No simulation made yet.</i>\n"
                tg_msg += "\n"
                
            if 'HR Prob' in hr_df.columns and not hr_df.empty:
                tg_msg += "🏆 <b>OVERALL TOP SAFE HR TARGETS:</b>\n"
                for _, row in hr_df.head(4).iterrows(): tg_msg += f"- {row['Player']}: {row['HR Prob']:.1f}%\n"
            send_telegram_alert(tg_msg)
        except Exception as e: st.error(f"Failed to generate Telegram payload: {e}")
            
    st.session_state.app_state = 'idle'
    st.session_state.run_payload = None

# --- HISTORICAL DATABASE SECTION ---
st.header("📚 Historical Database & Model Grading", divider="blue")
history = load_history()

if not history:
    st.info("No historical runs saved yet. Run the engine above first.")
else:
    run_options = {f"Slate: {run.get('date', 'Unknown')} (Updated: {run.get('timestamp', 'Unknown')})": run for run in reversed(history)}
    col_sel, col_del = st.columns([8, 2])
    with col_sel:
        selected_run_key = st.selectbox("Select a past Daily Master Slate to review:", list(run_options.keys()))
        selected_run = run_options[selected_run_key]
    with col_del:
        st.write("") 
        st.write("")
        if st.button("🗑️ Delete this Slate", use_container_width=True):
            delete_daily_master(selected_run.get('date', '')); st.rerun()

    st.markdown(f"### Predictions vs Reality for {selected_run.get('date', 'Unknown')}")
    simulated_games = [g for g in selected_run.get('games', []) if 'winner' in g]
    
    if simulated_games:
        if st.button(f"🔍 Fetch / Refresh Actual Results for {selected_run.get('date', 'Unknown')}", type="primary", use_container_width=True):
            with st.spinner("Pinging MLB APIs for real box scores..."):
                for game in simulated_games:
                    actual_data = get_actual_game_results(game.get('game_id'))
                    if actual_data: game['actual_results'] = actual_data
                save_daily_master(selected_run)
                
                correct_winners, total_games_played = 0, 0
                correct_f5, total_f5_played = 0, 0
                correct_hrs, total_hrs = 0, 0
                correct_tbs, total_tbs = 0, 0
                correct_yrfi = 0
                yrfi_bets = 0
                k_props_total, k_props_correct = 0, 0

                for game in simulated_games:
                    actual = game.get('actual_results', {})
                    if not actual: continue
                    
                    pred_w, act_w = game.get('winner', '').strip(), actual.get('winner', '').split(' (')[0].strip()
                    if 'PASS' not in pred_w:
                        total_games_played += 1
                        if pred_w == act_w: correct_winners += 1
                    
                    pred_f5, act_f5 = game.get('f5_pred', 'N/A').strip(), actual.get('f5_winner', 'N/A').split(' (')[0].strip()
                    if 'PASS' not in pred_f5 and pred_f5 != 'N/A':
                        total_f5_played += 1
                        if pred_f5 == act_f5: correct_f5 += 1
                    
                    is_act_yrfi = True if "YES" in actual.get('yrfi', '') else False
                    yrfi_rec = game.get('yrfi_rec', 'PASS')
                    if yrfi_rec != 'PASS':
                        yrfi_bets += 1
                        is_pred_yrfi = True if yrfi_rec == 'YRFI' else False
                        if is_act_yrfi == is_pred_yrfi: correct_yrfi += 1
                    
                    for p, prob in game.get('top_hr', []):
                        if 'NOT RECOMMENDED' in p or 'NONE' in p: continue
                        total_hrs += 1
                        if actual.get('hrs') != 'None' and p.split(' (')[0] in actual.get('hrs', ''): correct_hrs += 1
                    for p, prob in game.get('top_tb', []):
                        if 'NOT RECOMMENDED' in p or 'NONE' in p: continue
                        total_tbs += 1
                        if actual.get('tb') != 'None' and p.split(' (')[0] in actual.get('tb', ''): correct_tbs += 1
                        
                    if actual.get('away_pitcher_ks', 'N/A') != 'N/A':
                        act_k = float(actual['away_pitcher_ks'])
                        pred_str = game.get('away_5k_rec', '')
                        if 'YES' in pred_str:
                            match = re.search(r'YES (\d+)\+ Ks', pred_str)
                            if match:
                                target = int(match.group(1))
                                k_props_total += 1
                                if act_k >= target: k_props_correct += 1
                            elif 'YES' in pred_str: 
                                k_props_total += 1
                                if act_k >= 5: k_props_correct += 1
                        elif 'NO' in pred_str: 
                            k_props_total += 1
                            if act_k < 5: k_props_correct += 1
                            
                    if actual.get('home_pitcher_ks', 'N/A') != 'N/A':
                        act_k = float(actual['home_pitcher_ks'])
                        pred_str = game.get('home_5k_rec', '')
                        if 'YES' in pred_str:
                            match = re.search(r'YES (\d+)\+ Ks', pred_str)
                            if match:
                                target = int(match.group(1))
                                k_props_total += 1
                                if act_k >= target: k_props_correct += 1
                            elif 'YES' in pred_str:
                                k_props_total += 1
                                if act_k >= 5: k_props_correct += 1
                        elif 'NO' in pred_str:
                            k_props_total += 1
                            if act_k < 5: k_props_correct += 1

                win_pct = (correct_winners/total_games_played)*100 if total_games_played > 0 else 0
                f5_pct = (correct_f5/total_f5_played)*100 if total_f5_played > 0 else 0
                yrfi_pct = (correct_yrfi/yrfi_bets)*100 if yrfi_bets > 0 else 0
                hr_pct = (correct_hrs/total_hrs)*100 if total_hrs > 0 else 0
                tb_pct = (correct_tbs/total_tbs)*100 if total_tbs > 0 else 0
                k_acc_pct = (k_props_correct/k_props_total)*100 if k_props_total > 0 else 0

                try:
                    tg_msg = f"📊 <b>Model Evaluation Complete (v96): {selected_run.get('date', 'Unknown')}</b>\n\n"
                    tg_msg += f"🏆 <b>Winners:</b> {correct_winners}/{total_games_played} ({win_pct:.1f}%)\n"
                    tg_msg += f"⏱️ <b>F5 Winners:</b> {correct_f5}/{total_f5_played} ({f5_pct:.1f}%)\n"
                    tg_msg += f"🎯 <b>YRFI/NRFI Recs:</b> {correct_yrfi}/{yrfi_bets} ({yrfi_pct:.1f}%)\n"
                    tg_msg += f"🔥 <b>K Prop Targets:</b> {k_props_correct}/{k_props_total} ({k_acc_pct:.1f}%)\n"
                    tg_msg += f"💥 <b>HR Targets:</b> {correct_hrs}/{total_hrs} ({hr_pct:.1f}%)\n"
                    tg_msg += f"🏃 <b>2+ TB Targets:</b> {correct_tbs}/{total_tbs} ({tb_pct:.1f}%)\n\n"
                    tg_msg += "➖➖➖➖➖➖➖➖➖➖\n\n"

                    for game in simulated_games:
                        actual = game.get('actual_results', {})
                        if not actual: continue
                        yrfi_rec = game.get('yrfi_rec', 'PASS')
                        away_t, home_t = game.get('away_team', 'Away'), game.get('home_team', 'Home')
                        
                        tg_msg += f"▪️ <b>{game.get('matchup', 'Unknown')}</b>\n"
                        tg_msg += f"   🔄 Simulated: {game.get('last_simulated', 'Unknown')}\n"
                        tg_msg += f"🤖 <b>Pred:</b> {game.get('winner', 'N/A')} ({game.get('win_prob', 0.0):.1f}%) | ⏱️ F5: {game.get('f5_pred', 'N/A')} | {game.get('total_runs', 'N/A')} Runs | {yrfi_rec} ({game.get('yrfi', 0.0):.1f}%)\n"
                        tg_msg += f"⚾ <b>Actual:</b> {actual.get('winner', 'N/A')} | ⏱️ F5: {actual.get('f5_winner', 'N/A')} | {actual.get('total_runs', 'N/A')} Runs | {actual.get('yrfi', 'N/A')}\n"
                        
                        a_env, h_env = game.get('away_hr_env', ''), game.get('home_hr_env', '')
                        
                        if game.get('top_hr'):
                            safe_hrs = []
                            for p, prob in game.get('top_hr', []):
                                try:
                                    team_abbr = p.split('(')[-1].replace(')', '').strip()
                                    env_to_check = a_env if team_abbr in away_t.upper() else h_env
                                except:
                                    env_to_check = "POOR"
                                    
                                if "POOR" not in env_to_check:
                                    base_name = p.split(' (')[0]
                                    mark = "✅" if actual.get('hrs') != 'None' and base_name in actual.get('hrs', '') else "❌"
                                    safe_hrs.append(f"{mark} {p} ({prob:.1f}%)")
                                    
                            if safe_hrs: tg_msg += f"   ✅ <b>WORTHY HR BETS:</b> {', '.join(safe_hrs)}\n"
                            else: tg_msg += f"   🛑 <b>HR BETS:</b> NOT RECOMMENDED (Poor Environment)\n"
                        else: tg_msg += f"   🛑 <b>HR BETS:</b> NONE\n"
                                
                        if game.get('top_tb'):
                            tb_strs = []
                            for p, prob in game.get('top_tb', []):
                                base_name = p.split(' (')[0]
                                mark = "✅" if actual.get('tb') != 'None' and base_name in actual.get('tb', '') else "❌"
                                tb_strs.append(f"{mark} {p} ({prob:.1f}%)")
                            tg_msg += f"   🏃 <b>2+ TB Targets:</b> {', '.join(tb_strs)}\n"
                        else: tg_msg += f"   🏃 <b>2+ TB Targets:</b> NONE\n"
                        tg_msg += "\n"
                    send_telegram_alert(tg_msg)
                except Exception as e: st.error(f"Failed to push Telegram grading report: {e}")
                
                st.success("✅ Reality data permanently cached & sent to Telegram!")
                time.sleep(1)
                st.rerun()

        has_actuals = any('actual_results' in game for game in simulated_games)
        
        if has_actuals:
            correct_winners, total_games_played = 0, 0
            correct_f5, total_f5_played = 0, 0
            correct_hrs, total_hrs = 0, 0
            correct_tbs, total_tbs = 0, 0
            correct_yrfi = 0
            yrfi_bets = 0
            k_props_total, k_props_correct = 0, 0

            for game in simulated_games:
                actual = game.get('actual_results', {})
                if not actual: continue
                
                pred_w, act_w = game.get('winner', '').strip(), actual.get('winner', '').split(' (')[0].strip()
                if 'PASS' not in pred_w:
                    total_games_played += 1
                    if pred_w == act_w: correct_winners += 1
                
                pred_f5, act_f5 = game.get('f5_pred', 'N/A').strip(), actual.get('f5_winner', 'N/A').split(' (')[0].strip()
                if 'PASS' not in pred_f5 and pred_f5 != 'N/A':
                    total_f5_played += 1
                    if pred_f5 == act_f5: correct_f5 += 1
                
                is_act_yrfi = True if "YES" in actual.get('yrfi', '') else False
                yrfi_rec = game.get('yrfi_rec', 'PASS')
                if yrfi_rec != 'PASS':
                    yrfi_bets += 1
                    is_pred_yrfi = True if yrfi_rec == 'YRFI' else False
                    if is_act_yrfi == is_pred_yrfi: correct_yrfi += 1
                    
                for p, prob in game.get('top_hr', []):
                    if 'NOT RECOMMENDED' in p or 'NONE' in p: continue
                    total_hrs += 1
                    if actual.get('hrs') != 'None' and p.split(' (')[0] in actual.get('hrs', ''): correct_hrs += 1
                for p, prob in game.get('top_tb', []):
                    if 'NOT RECOMMENDED' in p or 'NONE' in p: continue
                    total_tbs += 1
                    if actual.get('tb') != 'None' and p.split(' (')[0] in actual.get('tb', ''): correct_tbs += 1
                    
                if actual.get('away_pitcher_ks', 'N/A') != 'N/A':
                    act_k = float(actual['away_pitcher_ks'])
                    pred_str = game.get('away_5k_rec', '')
                    if 'YES' in pred_str:
                        match = re.search(r'YES (\d+)\+ Ks', pred_str)
                        if match:
                            target = int(match.group(1))
                            k_props_total += 1
                            if act_k >= target: k_props_correct += 1
                        elif 'YES' in pred_str: 
                            k_props_total += 1
                            if act_k >= 5: k_props_correct += 1
                    elif 'NO' in pred_str: 
                        k_props_total += 1
                        if act_k < 5: k_props_correct += 1
                        
                if actual.get('home_pitcher_ks', 'N/A') != 'N/A':
                    act_k = float(actual['home_pitcher_ks'])
                    pred_str = game.get('home_5k_rec', '')
                    if 'YES' in pred_str:
                        match = re.search(r'YES (\d+)\+ Ks', pred_str)
                        if match:
                            target = int(match.group(1))
                            k_props_total += 1
                            if act_k >= target: k_props_correct += 1
                        elif 'YES' in pred_str: 
                            k_props_total += 1
                            if act_k >= 5: k_props_correct += 1
                    elif 'NO' in pred_str: 
                        k_props_total += 1
                        if act_k < 5: k_props_correct += 1
            
            st.markdown("#### 📊 Daily Accuracy Summary")
            
            k_acc_pct = (k_props_correct/k_props_total)*100 if k_props_total > 0 else 0
            
            sum_c1, sum_c2, sum_c3, sum_c4, sum_c5 = st.columns(5)
            with sum_c1: st.metric("🏆 Winners", f"{correct_winners} / {total_games_played}", f"{(correct_winners/total_games_played)*100 if total_games_played > 0 else 0:.1f}%")
            with sum_c2: st.metric("⏱️ F5 Winners", f"{correct_f5} / {total_f5_played}", f"{(correct_f5/total_f5_played)*100 if total_f5_played > 0 else 0:.1f}%")
            with sum_c3: st.metric("🎯 YRFI Recs", f"{correct_yrfi} / {yrfi_bets}", f"{(correct_yrfi/yrfi_bets)*100 if yrfi_bets > 0 else 0:.1f}%")
            with sum_c4: st.metric("🔥 K Prop Targets", f"{k_props_correct} / {k_props_total}", f"{k_acc_pct:.1f}%")
            with sum_c5: st.metric("💥 HR Targets", f"{correct_hrs} / {total_hrs}", f"{(correct_hrs/total_hrs)*100 if total_hrs > 0 else 0:.1f}%")
            st.metric("🏃 2+ TB Targets", f"{correct_tbs} / {total_tbs}", f"{(correct_tbs/total_tbs)*100 if total_tbs > 0 else 0:.1f}%")
            st.divider()

            csv_data = []
            for game in simulated_games:
                actual = game.get('actual_results', {})
                yrfi_rec = game.get('yrfi_rec', 'PASS')
                
                a_env = game.get('away_hr_env', game.get('hr_env', 'N/A'))
                h_env = game.get('home_hr_env', game.get('hr_env', 'N/A'))
                
                csv_data.append({
                    "Matchup": game.get('matchup', 'Unknown'), 
                    "Away Pitcher": game.get('away_pitcher', 'TBD'),
                    "Pred Away K Prop": game.get('away_5k_rec', 'N/A'),
                    "Actual Away Ks": actual.get('away_pitcher_ks', 'N/A'),
                    "Home Pitcher": game.get('home_pitcher', 'TBD'),
                    "Pred Home K Prop": game.get('home_5k_rec', 'N/A'),
                    "Actual Home Ks": actual.get('home_pitcher_ks', 'N/A'),
                    "Last Simulated": game.get('last_simulated', 'Unknown'),
                    "Away HR Env": a_env,
                    "Home HR Env": h_env,
                    "Lineups": game.get('lineup_status', 'Unknown'), "Pred Winner": game.get('winner', 'N/A'),
                    "Pred Win Prob (%)": round(game.get('win_prob', 0.0), 1), "Actual Winner": actual.get('winner', 'N/A'),
                    "Pred F5 Winner": game.get('f5_pred', 'N/A'), "Pred F5 Prob (%)": round(game.get('f5_prob', 0.0), 1),
                    "Actual F5 Winner": actual.get('f5_winner', 'N/A'), "Pred Spread": game.get('spread', 1.0),
                    "Pred Total Runs": game.get('total_runs', 'N/A'), "Actual Total Runs": actual.get('total_runs', 'N/A'),
                    "Pred YRFI Rec": yrfi_rec, "Pred YRFI Prob (%)": round(game.get('yrfi', 0.0), 1),
                    "Actual YRFI": actual.get('yrfi', 'N/A'),
                    "Pred Top HRs": ", ".join([f"{p} ({round(prob, 1)}%)" for p, prob in game.get('top_hr', [])]) if game.get('top_hr') else "NONE", "Actual HRs": actual.get('hrs', 'N/A'),
                    "Pred 2+ TBs": ", ".join([f"{p} ({round(prob, 1)}%)" for p, prob in game.get('top_tb', [])]) if game.get('top_tb') else "NONE", "Actual TBs": actual.get('tb', 'N/A')
                })
            
            if csv_data:
                df_export = pd.DataFrame(csv_data)
                st.download_button(label="📥 Download Model Evaluation CSV", data=df_export.to_csv(index=False).encode('utf-8'), file_name=f"mlb_quant_eval_{selected_run.get('date', 'Unknown')}.csv", mime="text/csv")

        for game in simulated_games:
            yrfi_rec = game.get('yrfi_rec', 'PASS')
            with st.expander(f"{game.get('matchup', 'Unknown')} | Pred Winner: {game.get('winner', 'N/A')} | Play {yrfi_rec} ({game.get('yrfi', 0.0):.1f}%)", expanded=has_actuals):
                col_pred, col_actual = st.columns(2)
                with col_pred:
                    st.markdown("#### 🤖 Model Prediction")
                    st.write(f"**Last Simulated:** `{game.get('last_simulated', 'Unknown')}`")
                    
                    away_p_name = game.get('away_pitcher', 'TBD').split(' ')[-1]
                    home_p_name = game.get('home_pitcher', 'TBD').split(' ')[-1]
                    st.write(f"**K Props:** {away_p_name} `{game.get('away_5k_rec', 'N/A')}` | {home_p_name} `{game.get('home_5k_rec', 'N/A')}`")
                    
                    st.write(f"**Lineups:** {game.get('lineup_status', 'Unknown')}")
                    st.write(f"**Winner:** {game.get('winner', 'N/A')} ({game.get('win_prob', 0.0):.1f}%) | Spread: {game.get('spread', 1.0)}")
                    st.write(f"**F5 Winner:** {game.get('f5_pred', 'N/A')} ({game.get('f5_prob', 0.0):.1f}%)")
                    st.write(f"**Total Expected Runs:** {game.get('total_runs', 'N/A')}")
                    st.write(f"**YRFI Prob:** {game.get('yrfi', 0.0):.1f}% (👉 **Play: {yrfi_rec}**)")
                    st.write("**Top HR Targets:**")
                    
                    a_env = game.get('away_hr_env', game.get('hr_env', 'N/A'))
                    h_env = game.get('home_hr_env', game.get('hr_env', 'N/A'))
                    away_team_name = game.get('away_team', 'Away').split(' ')[-1]
                    home_team_name = game.get('home_team', 'Home').split(' ')[-1]
                    
                    st.caption(f"{away_team_name} Off: {a_env}")
                    st.caption(f"{home_team_name} Off: {h_env}")
                    
                    if game.get('top_hr'):
                        for p, prob in game.get('top_hr', []):
                            if has_actuals and 'actual_results' in game:
                                base_name = p.split(' (')[0]
                                if game['actual_results'].get('hrs') != 'None' and base_name in game['actual_results'].get('hrs', ''): st.write(f"- :green[{p}: {prob:.1f}% ✅]")
                                else: st.write(f"- :red[{p}: {prob:.1f}% ❌]")
                            else: st.write(f"- {p}: {prob:.1f}%")
                    else: st.write("`NONE (Skipping Game)`")
                    
                    st.write("**Top 2+ TB Targets:**")
                    if game.get('top_tb'):
                        for p, prob in game.get('top_tb', []):
                            if has_actuals and 'actual_results' in game:
                                base_name = p.split(' (')[0]
                                if game['actual_results'].get('tb') != 'None' and base_name in game['actual_results'].get('tb', ''): st.write(f"- :green[{p}: {prob:.1f}% ✅]")
                                else: st.write(f"- :red[{p}: {prob:.1f}% ❌]")
                            else: st.write(f"- {p}: {prob:.1f}%")
                    else: st.write("`NONE (Skipping Game)`")
                with col_actual:
                    st.markdown("#### ⚾ Actual Reality")
                    if 'actual_results' in game:
                        actual = game['actual_results']
                        st.success(f"**Actual Winner & Score:** {actual.get('winner', 'N/A')}")
                        st.write(f"**Actual F5 Winner:** {actual.get('f5_winner', 'N/A')}")
                        st.write(f"**Actual Total Runs:** {actual.get('total_runs', 'N/A')}")
                        st.info(f"**Actual YRFI:** {actual.get('yrfi', 'N/A')}")
                        st.write(f"**Actual Strikeouts:** {away_p_name} `{actual.get('away_pitcher_ks', 'N/A')}` | {home_p_name} `{actual.get('home_pitcher_ks', 'N/A')}`")
                        st.warning(f"**Actual HR Hitters:** {actual.get('hrs', 'N/A')}")
                        st.info(f"**Actual 2+ TB Hitters:** {actual.get('tb', 'N/A')}")
                    else: st.error("Reality Data not yet fetched or game was postponed.")
