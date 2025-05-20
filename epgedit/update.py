from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
import boto3
import xml.etree.ElementTree as ET
import logging
from datetime import datetime, timedelta
import json
import os

app = FastAPI()

# Allow CORS for the specific origin
origins = [
    "http://ec2-50-112-157-77.us-west-2.compute.amazonaws.com"
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(level=logging.INFO)

# AWS S3 configuration
s3_client = boto3.client('s3')
bucket_name = 'raghutestvideo'
xml_file_key = 'fast-channel/xmltv/sivesh-xmltv.xml'
rules_file_key = 'fast-channel/xmltv/Time_Slot_Rules_Array.json'
neighbour_rules_file_key = 'fast-channel/xmltv/Neighbour_Rules.json'
archive_folder = "fast-channel/xmltv/xmltv-archive/edited-files-archive"

# In-memory session management
session_state = {}

# Function to read a json file in s3 bucket
def load_json(bucket_name, key):
    response = s3_client.get_object(Bucket=bucket_name, Key=key)
    content = response['Body'].read().decode('utf-8')
    return json.loads(content)

# Function to create a version file whenever session restarts
def get_next_version_number():
    response = s3_client.list_objects_v2(Bucket=bucket_name, Prefix='fast-channel/xmltv/sivesh-xmltv_v')
    existing_versions = [obj['Key'] for obj in response.get('Contents', [])]
    version_numbers = [int(key.split('_v')[-1].split('_')[0]) for key in existing_versions if '_v' in key]
    next_version = max(version_numbers, default=0) + 1
    return next_version

# Function to write a temporary edited invalid schedule to server
def write_to_temporary_file(xml_data):
    temp_file_path = '/usr/share/nginx/html/epgedit/edited_inprogress_file.xml'  # Updating the invalid schedule
    with open(temp_file_path, 'wb') as temp_file:
        temp_file.write(xml_data)

# Function to fetch the xml file in s3 when we load the UI page and also to create a backup version file whenever session restarts
@app.get("/fetch_xml")
async def fetch_xml(date: str = None):
    try:
        if not session_state.get('backup_created'):
            next_version = get_next_version_number()
            current_date = datetime.now().strftime('%m-%d-%Y')
            backup_key = xml_file_key.replace('.xml', f'_v{next_version}_{current_date}.xml')
            s3_client.copy_object(Bucket=bucket_name, CopySource={'Bucket': bucket_name, 'Key': xml_file_key}, Key=backup_key)
            session_state['backup_created'] = True

        s3_response = s3_client.get_object(Bucket=bucket_name, Key=xml_file_key)
        xml_data = s3_response['Body'].read()

        if date:
            xml_data = filter_programs_by_date(xml_data, date)

        return Response(content=xml_data, media_type="application/xml")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# Function to filter programs in UI page according to the date change in UI
def filter_programs_by_date(xml_data, date):
    root = ET.fromstring(xml_data)
    filtered_root = ET.Element("tv", root.attrib)

    for channel in root.findall('channel'):
        filtered_root.append(channel)

    for program in root.findall('program'):
        start_date = datetime.strptime(program.get('start'), '%Y%m%d%H%M%S').strftime('%Y-%m-%d')
        if start_date == date:
            filtered_root.append(program)

    return ET.tostring(filtered_root, encoding='utf-8', method='xml')

# Function to send the Updated schedule to s3 back to its location whenever there are some changes happens in UI and after clicking on save button
@app.post("/update_schedule", response_class=Response)
async def update_schedule(request: Request):
    try:
        body = await request.body()
        logging.info(f"Payload received: {body.decode('utf-8')}")
        root = ET.fromstring(body)

        xml_url = root.find('xml_url').text
        channel_id = root.find('channel_id').text
        programs = root.find('programs')

        # Fetch XML from S3
        s3_response = s3_client.get_object(Bucket=bucket_name, Key=xml_file_key)
        xml_data = s3_response['Body'].read()

        tree = ET.ElementTree(ET.fromstring(xml_data))
        root = tree.getroot()

        program_dict = {}
        channel_dict = {}

        # Parse channel information
        for channel in root.findall('channel'):
            ch_id = channel.get('id')
            display_name = channel.find('display-name').text if channel.find('display-name') is not None else ''
            icon = channel.find('icon').get('src') if channel.find('icon') is not None else ''
            channel_dict[ch_id] = {
                'display_name': display_name,
                'icon': icon
            }

        # Parse program information
        for program in root.findall('program'):
            title_element = program.find('title')
            title_id = title_element.get('id') if title_element is not None else ''
            start = datetime.strptime(program.get('start'), '%Y%m%d%H%M%S')
            stop = datetime.strptime(program.get('stop'), '%Y%m%d%H%M%S')
            duration = int((stop - start).total_seconds() // 60)
            desc = program.find('desc').text if program.find('desc') is not None else ''
            genres = program.find('genres').text if program.find('genres') is not None else ''
            pc_rating = program.find('pc_rating').text if program.find('pc_rating') is not None else ''
            ad_slate_length = int(program.find('ad_slate_length').text) if program.find('ad_slate_length') is not None else 0
            applied_rules = program.find('applied_rules').text if program.find('applied_rules') is not None else ''
            ch_id = program.get('channel')

            # Use a composite key of channel_id and title_id
            program_key = f"{ch_id}_{title_id}"
            program_dict[program_key] = {
                'channel_id': ch_id,
                'start': start,
                'stop': stop,
                'duration': duration,
                'title': title_element.text if title_element is not None else '',
                'desc': desc,
                'genres': genres,
                'pc_rating': pc_rating,
                'ad_slate_length': ad_slate_length,
                'applied_rules': applied_rules
            }

        updated_programs = []
        current_time = datetime.combine(datetime.today(), datetime.min.time())

        for program in programs.findall('Program'):
            title_id = program.find('id').text
            channel_id = program.find('channel_id').text
            program_key = f"{channel_id}_{title_id}"
            if program_key not in program_dict:
                raise HTTPException(status_code=400, detail=f"Program ID {title_id} for channel {channel_id} not found in XML data")
            duration = program_dict[program_key]['duration']
            ad_slate_length = program_dict[program_key]['ad_slate_length']
            additional_ad_slate_length = int(program.find('additional_ad_slate_length').text) if program.find('additional_ad_slate_length') is not None else 0
            total_duration = duration
            end_time = current_time + timedelta(minutes=total_duration) + timedelta(minutes=additional_ad_slate_length)
            updated_programs.append({
                'channel_id': program_dict[program_key]['channel_id'],
                'id': title_id,
                'start': current_time.strftime('%Y%m%d%H%M%S'),
                'end': end_time.strftime('%Y%m%d%H%M%S'),
                'title': program_dict[program_key]['title'],
                'desc': program_dict[program_key]['desc'],
                'genres': program_dict[program_key]['genres'],
                'pc_rating': program_dict[program_key]['pc_rating'],
                'ad_slate_length': ad_slate_length + additional_ad_slate_length,
                'duration': total_duration,
                'applied_rules': program_dict[program_key]['applied_rules']
            })
            current_time = end_time

        logging.info(f"Updated programs: {updated_programs}")

        # Combine existing (means the program channels that are not edited) and updated programs
        all_programs = [program for program in root.findall('program') if program.get('channel') != channel_id]
        for updated_program in updated_programs:
            program_element = ET.Element("program", {
                "channel": updated_program['channel_id'],
                "start": updated_program['start'],
                "stop": updated_program['end']
            })
            title_element = ET.SubElement(program_element, "title", {
                "lang": "en",
                "id": updated_program['id'],
                "duration": str(updated_program['duration'])
            })
            title_element.text = updated_program['title']
            desc_element = ET.SubElement(program_element, "desc", {"lang": "en"})
            desc_element.text = updated_program['desc']
            genre_element = ET.SubElement(program_element, "genres", {"lang": "en"})
            genre_element.text = updated_program['genres']
            rating_element = ET.SubElement(program_element, "pc_rating", {"lang": "en"})
            rating_element.text = updated_program['pc_rating']
            ad_slate_length_element = ET.SubElement(program_element, "ad_slate_length")
            ad_slate_length_element.text = str(updated_program['ad_slate_length'])
            applied_rules_element = ET.SubElement(program_element, "applied_rules", {"lang": "en"})
            applied_rules_element.text = updated_program['applied_rules']
            all_programs.append(program_element)

      # Sort all programs by channel ID
        all_programs.sort(key=lambda x: x.get('channel'))

        now = datetime.now()
        offset = timedelta(hours=5, minutes=30)
        now_with_offset = now + offset
        formatted_datetime = now_with_offset.strftime('%Y%m%d%H%M%S')
        timezone_offset = '+0530'
        # Combine the formatted date and time with the timezone offset
        time_for_epg = f"{formatted_datetime} {timezone_offset}"

        # Create XML response
        final_tv_element = ET.Element("tv", date=time_for_epg, generator_ENfo_name="epg.pw", generator_ENfo_url="https://epg.pw", source_ENfo_name="FREE EPG", source_ENfo_url="https://epg.pw/xmltv/epg_EN.xml")

        # Add channel information
        for ch_id, channel_info in channel_dict.items():
            channel_element = ET.SubElement(final_tv_element, "channel", {"id": ch_id})
            display_name_element = ET.SubElement(channel_element, "display-name", {"lang": "en"})
            display_name_element.text = channel_info['display_name']
            if channel_info['icon']:
                icon_element = ET.SubElement(channel_element, "icon", {"src": channel_info['icon']})

        # Add sorted program information
        for program in all_programs:
            final_tv_element.append(program)

        # Serialize the updated XML
        updated_xml = ET.tostring(final_tv_element, encoding='utf-8', method='xml')

        # Save the updated XML to a local server
        local_file_path = '/usr/share/nginx/html/epgedit/final-xmltv.xml'
        with open(local_file_path, 'wb') as local_file:
            local_file.write(updated_xml)

        # Upload the updated XML back to S3
        s3_client.put_object(Bucket=bucket_name, Key=xml_file_key, Body=updated_xml, ContentType='application/xml')

        # Archive the updated schedule with a timestamp
        timestamp = datetime.now().strftime('%Y%m%d%H%M%S')
        archive_key = f"{archive_folder}/sivesh-xmltv-edited-{timestamp}.xml"
        s3_client.put_object(Bucket=bucket_name, Key=archive_key, Body=updated_xml, ContentType='application/xml')

        return Response(content=updated_xml, media_type="application/xml")
    except Exception as e:
        logging.error(f"Unexpected error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

def check_conditions(movie, conditions):
    if "AND" in conditions:
        return all(evaluate_condition(movie, condition) for condition in conditions["AND"])
    elif "OR" in conditions:
        return any(evaluate_condition(movie, condition) for condition in conditions["OR"])
    return False

def evaluate_condition(movie, condition):
    field = condition["Field"]
    right_param = condition["Value"]
    movie_value = movie[field]
    expression = condition["Expression"]

    if field == "pc_rating":
        pc_rating_map = {"G": 1, "PG": 2, "PG-13": 3, "R": 4, "NC-17": 5}
        movie_value = pc_rating_map.get(movie_value, 0)
        right_param = pc_rating_map.get(right_param, 0)

    switch = {
        "==": movie_value == right_param,
        "!=": movie_value != right_param,
        "<=": movie_value <= right_param,
        ">=": movie_value >= right_param,
        "<": movie_value < right_param,
        ">": movie_value > right_param
    }
    return switch.get(expression, False)

# Function to validate the changed schedule in UI it will work after clicking on validate button in UI
@app.post("/validate_schedule")
async def validate_schedule(request: Request):
    try:
        body = await request.json()
        logging.info(f"Received payload: {body}")
        schedule = body['schedule']
        primary_rules = load_json(bucket_name, rules_file_key)
        neighbour_rules = load_json(bucket_name, neighbour_rules_file_key)
        primary_rules = [rule for rule in primary_rules if rule["Rule Precedence"] != 0]
        invalid_movies = []

        for movie in schedule:
            valid_timeslot = None
            invalid_reason = None

            for rule in sorted(primary_rules, key=lambda x: -x["Rule Precedence"]):
                logging.info(f"Checking rule for {movie['movieId']}: {rule['Rule Id']} - {rule['Rule Title']}")
                if check_conditions(movie, rule["Condition"]):
                    valid_timeslot = rule["Result"]["End Result"]
                    logging.info(f"Valid timeslot found for {movie['movieId']}: {valid_timeslot}")
                    if movie["timeslot"] in valid_timeslot:
                        invalid_reason = None
                        break
                    else:
                        invalid_reason = f"Title cannot be placed in {movie['timeslot']} due to rule: {rule['Rule Short Desc']}"
                        break

            if invalid_reason:
                invalid_movies.append({
                    "movieId": movie["movieId"],
                    "reason": invalid_reason
                })

        logging.info("Timeslot rules validation complete. Now checking neighbour rules.")

        # Validate neighbour rules
        for i in range(1, len(schedule)):
            current_movie = schedule[i]
            previous_movie = schedule[i - 1]
            previous_movie1 = schedule[i - 2] if i > 1 else None
            for rule in neighbour_rules:
                logging.info(f"Checking neighbour rule for {current_movie['movieId']}: {rule['Rule Id']} - {rule['Rule Title']}")
                if check_order_conditions(current_movie, previous_movie, previous_movie1, rule["Conditions"]):
                    if rule["Result"]["End Result"] == "Invalid":
                        invalid_movies.append({
                            "movieId": current_movie["movieId"],
                            "reason": f"Neighbour rule violated: {rule['Rule Desc']}"
                        })

        valid = len(invalid_movies) == 0
        logging.info(f"Validation result: {'valid' if valid else 'invalid'}")

        if not valid:
            # Create XML for invalid schedule
            root = ET.Element("tv")
            for movie in schedule:
                program = ET.SubElement(root, "program", channel=movie['channelId'], start=movie['start'], stop=movie['stop'])
                ET.SubElement(program, "title", lang="en", id=movie['movieId'], duration=str(movie['duration'])).text = movie['title']
                ET.SubElement(program, "desc", lang="en").text = movie['desc']
                ET.SubElement(program, "genres", lang="en").text = movie['genres']
                ET.SubElement(program, "pc_rating", lang="en").text = movie['pc_rating']
                ET.SubElement(program, "ad_slate_length").text = str(movie['adSlateLength'])
                ET.SubElement(program, "applied_rules", lang="en").text = movie['applied_rules']

            xml_data = ET.tostring(root, encoding='utf-8', method='xml')
            write_to_temporary_file(xml_data)

        return {"valid": valid, "invalidMovies": invalid_movies}
    except Exception as e:
        logging.error(f"Unexpected error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

def check_order_conditions(current_movie, previous_movie, previous_movie1, conditions):
    if "AND" in conditions:
        return all(evaluate_order_condition(current_movie, previous_movie, previous_movie1, condition) for condition in conditions["AND"])
    elif "OR" in conditions:
        return any(evaluate_order_condition(current_movie, previous_movie, previous_movie1, condition) for condition in conditions["OR"])
    return False

def evaluate_order_condition(current_movie, previous_movie, previous_movie1, condition):
    left_param = condition["Left Parameter"]
    right_param = condition["Right Parameter"]
    expression = condition["Expression"]

    if left_param.startswith("current_movie_"):
        left_value = current_movie.get(left_param[len("current_movie_"):], "")
    elif left_param.startswith("previous_movie_"):
        left_value = previous_movie.get(left_param[len("previous_movie_"):], "")
    elif left_param.startswith("previous_movie1_"):
        left_value = previous_movie1.get(left_param[len("previous_movie1_"):], "") if previous_movie1 else ""

    if isinstance(right_param, list):
        right_value = right_param
    else:
        if right_param.startswith("current_movie_"):
            right_value = current_movie.get(right_param[len("current_movie_"):], "")
        elif right_param.startswith("previous_movie_"):
            right_value = previous_movie.get(right_param[len("previous_movie_"):], "")
        elif right_param.startswith("previous_movie1_"):
            right_value = previous_movie1.get(right_param[len("previous_movie1_"):], "") if previous_movie1 else ""
        else:
            right_value = right_param

    logging.info(f"Evaluating condition: {left_value} {expression} {right_value}")

    switch = {
        "==": left_value == right_value,
        "IN": left_value in right_value
    }
    return switch.get(expression, False)

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='0.0.0.0', port=8200)
