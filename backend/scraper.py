from flask import Flask, request, jsonify
from flask_cors import CORS
import requests
import urllib.parse

app = Flask(__name__)
# Allows your React frontend to communicate with this Python backend
CORS(app) 

# Your exact RapidAPI credentials from the screenshot
RAPIDAPI_KEY = "9b174ca1e4msh73e3891b8fd6f0ap1b88edjsnaee1d15408a5"
RAPIDAPI_HOST = "google-map-places.p.rapidapi.com"

def get_rapidapi_data(name, location):
    print(f"\n📡 Querying RapidAPI (Google) for: {name} near {location}")
    
    # We use the textsearch endpoint to grab the Google ratings and reviews
    url = "https://google-map-places.p.rapidapi.com/maps/api/place/textsearch/json"
    
    # Construct the query exactly how a user would type it into Google Maps
    querystring = {"query": f"{name} {location}"}
    
    headers = {
        "x-rapidapi-host": RAPIDAPI_HOST,
        "x-rapidapi-key": RAPIDAPI_KEY
    }
    
    try:
        response = requests.get(url, headers=headers, params=querystring)
        
        # Safety check if RapidAPI blocks the request (e.g., out of quota)
        if response.status_code != 200:
            print(f"❌ API Error: {response.status_code} - {response.text}")
            return {"error": "RapidAPI connection failed. Check your API quota.", "source": "Google"}
            
        data = response.json()
        
        # If the API found the business, extract the ratings safely
        if data.get("status") == "OK" and len(data.get("results", [])) > 0:
            best_match = data["results"][0]
            
            rating = best_match.get("rating", "N/A")
            reviews = best_match.get("user_ratings_total", 0)
            
            # Google doesn't provide Yelp-style categories here, so we use their exact address
            address = best_match.get("formatted_address", "No address provided.")
            
            print(f"✅ Found! {rating} stars, {reviews} reviews.")
            
            return {
                "scraped_rating": str(rating),
                "scraped_reviews": str(reviews),
                "scraped_photo": None, # Skipping photo fetching to make the API lightning fast
                "scraped_description": f"📍 {address}",
                "source": "Google",
                "error": None
            }
        else:
            print("⚠️ Business not found on Google Maps.")
            return {"error": "Not found on Google.", "source": "Google"}
            
    except Exception as e:
        print(f"❌ API Request failed: {e}")
        return {"error": "API connection failed.", "source": "Google"}

@app.route('/get_details', methods=['GET'])
def get_details():
    name = request.args.get('name')
    location = request.args.get('location')
    
    if not name or not location:
        return jsonify({"error": "Missing name or location"}), 400
        
    # Trigger the RapidAPI fetcher
    data = get_rapidapi_data(name, location)
    
    return jsonify(data)

if __name__ == '__main__':
    print("🚀 RapidAPI Server running on port 5000...")
    print("✅ Web scraping disabled. Using fast API connections.")
    app.run(port=5000)