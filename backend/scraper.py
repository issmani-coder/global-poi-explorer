from flask import Flask, request, jsonify, Response
from flask_cors import CORS
import requests
import urllib.parse

app = Flask(__name__)
CORS(app) 

RAPIDAPI_KEY = "9b174ca1e4msh73e3891b8fd6f0ap1b88edjsnaee1d15408a5"
RAPIDAPI_HOST = "google-map-places.p.rapidapi.com"

def get_rapidapi_data(name, location):
    print(f"\n📡 Querying RapidAPI (Google) for: {name} near {location}")
    url = "https://google-map-places.p.rapidapi.com/maps/api/place/textsearch/json"
    querystring = {"query": f"{name} {location}"}
    
    headers = {
        "x-rapidapi-host": RAPIDAPI_HOST,
        "x-rapidapi-key": RAPIDAPI_KEY
    }
    
    try:
        response = requests.get(url, headers=headers, params=querystring)
        if response.status_code != 200:
            return {"error": "RapidAPI connection failed. Check your API quota.", "source": "Google"}
            
        data = response.json()
        
        if data.get("status") == "OK" and len(data.get("results", [])) > 0:
            best_match = data["results"][0]
            rating = best_match.get("rating", "N/A")
            reviews = best_match.get("user_ratings_total", 0)
            address = best_match.get("formatted_address", "No address provided.")
            
            # GRAB THE PHOTO REFERENCE (If it exists)
            photo_ref = None
            if "photos" in best_match and len(best_match["photos"]) > 0:
                photo_ref = best_match["photos"][0]["photo_reference"]
            
            return {
                "scraped_rating": str(rating),
                "scraped_reviews": str(reviews),
                "scraped_photo_ref": photo_ref, # Pass the secret reference to React
                "scraped_description": f"📍 {address}",
                "source": "Google",
                "error": None
            }
        else:
            return {"error": "Not found on Google.", "source": "Google"}
            
    except Exception as e:
        return {"error": "API connection failed.", "source": "Google"}

@app.route('/get_details', methods=['GET'])
def get_details():
    name = request.args.get('name')
    location = request.args.get('location')
    if not name or not location:
        return jsonify({"error": "Missing name or location"}), 400
    return jsonify(get_rapidapi_data(name, location))

# NEW: THE IMAGE PROXY ROUTE
@app.route('/get_image', methods=['GET'])
def get_image():
    ref = request.args.get('ref')
    if not ref:
        return "Missing reference", 400
        
    url = "https://google-map-places.p.rapidapi.com/maps/api/place/photo"
    querystring = {"maxwidth": "400", "photo_reference": ref}
    headers = {
        "x-rapidapi-host": RAPIDAPI_HOST,
        "x-rapidapi-key": RAPIDAPI_KEY
    }
    
    try:
        # We fetch the raw image bytes securely from Google
        response = requests.get(url, headers=headers, params=querystring, allow_redirects=True)
        # And stream them directly back to the React <img> tag!
        return Response(response.content, mimetype=response.headers.get('Content-Type', 'image/jpeg'))
    except Exception as e:
        return "Image fetch failed", 500

if __name__ == '__main__':
    print("🚀 RapidAPI Server running on port 5000...")
    app.run(port=5000)