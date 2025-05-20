document.addEventListener('DOMContentLoaded', function() {
    const apiUrl = 'http://ec2-50-112-157-77.us-west-2.compute.amazonaws.com:8200';
    const validateButton = document.getElementById('validate-button');
    const submitButton = document.getElementById('submit-button');
    const datePicker = document.getElementById('date-picker');
    let draggedMovie = null;

	//Defining the timeslots to know what timings a slot comes under in UI for the coloring purpose
    const timeSlots = {
        "Mid Night": ["00:00", "04:00"],
        "Early Morning": ["04:00", "07:30"],
        "Morning Time": ["07:30", "10:30"],
        "Late Morning": ["10:30", "12:00"],
        "Afternoon Time": ["12:00", "16:30"],
        "Evening Time": ["16:30", "19:00"],
        "Prime Time": ["19:00", "22:00"],
        "Late Night": ["22:00", "23:59"]
    };

	//Function to know in UI what timings a slot comes under
    function getTimeSlotClass(startTime) {
        const time = moment(startTime, 'HH:mm:ss');
        for (const [slot, range] of Object.entries(timeSlots)) {
            const [start, end] = range.map(t => moment(t, 'HH:mm'));
            if (time.isBetween(start, end, null, '[)')) {
                return slot; // Return the timeslot in the same format as the rules
            }
        }
        return '';
    }

    function updateAdSlateLength(row, change) {
        let adSlateLength = parseInt(row.dataset.adSlateLength) + change;
        row.dataset.adSlateLength = adSlateLength;
        row.querySelector('#ad-slate-length').textContent = `${adSlateLength} min`;
        recalculateTimeSlots();
        validateButton.disabled = false;
        submitButton.disabled = true;

        // Update the movie object for validation
        draggedMovie = {
            movieId: row.dataset.movieId,
            start: row.dataset.start,
            stop: row.dataset.stop,
            timeslot: row.dataset.timeslot,
            pc_rating: row.dataset.pcRating,
            genres: row.dataset.genres,
            adSlateLength: row.dataset.adSlateLength
        };
    }

    // Attach event listeners(+ and -) for gap filler buttons
    document.querySelectorAll('.decrease-ad').forEach(button => {
        button.addEventListener('click', function() {
            const row = button.closest('tr');
            updateAdSlateLength(row, -1);
        });
    });

    document.querySelectorAll('.increase-ad').forEach(button => {
        button.addEventListener('click', function() {
            const row = button.closest('tr');
            updateAdSlateLength(row, 1);
        });
    });

    function fetchAndUpdateEPG(channelId, selectedDate) {
        const url = new URL(`${apiUrl}/fetch_xml`);
        if (selectedDate) {
            url.searchParams.append('date', selectedDate);
        }

        fetch(url)
            .then(response => response.text())
            .then(data => {
                const parser = new DOMParser();
                const xmlDoc = parser.parseFromString(data, 'application/xml');
                const programmes = xmlDoc.getElementsByTagName('program');
                updateEPG(channelId, programmes, selectedDate);
            })
            .catch(error => console.error('Error fetching XML:', error));
    }

    function updateEPG(channelId, programmes, selectedDate) {
        const epgBody = document.getElementById('epg-body');
        epgBody.innerHTML = ''; // Clear existing rows

        // Filter programmes by selected channel and date
        const filteredProgrammes = Array.from(programmes).filter(programme => {
            const programmeDate = moment(programme.getAttribute('start'), 'YYYYMMDDHHmmss').format('YYYY-MM-DD');
            return programme.getAttribute('channel') === channelId && programmeDate === selectedDate;
        });

        if (filteredProgrammes.length === 0) {
            epgBody.innerHTML = '<tr><td colspan="3">There are no programs scheduled for this date.</td></tr>';
            return;
        }

        // Generate time slots and add program schedule
        for (let programme of filteredProgrammes) {
            const start = moment(programme.getAttribute('start'), 'YYYYMMDDHHmmss');
            const stop = moment(programme.getAttribute('stop'), 'YYYYMMDDHHmmss');
            const duration = stop.diff(start, 'minutes'); // Duration in minutes
            const titleElement = programme.getElementsByTagName('title')[0];
            const title = titleElement.textContent;
            const movieId = titleElement.getAttribute('id');
            const desc = programme.getElementsByTagName('desc')[0]?.textContent || '';
            const genres = programme.getElementsByTagName('genres')[0].textContent;
            const pc_rating = programme.getElementsByTagName('pc_rating')[0].textContent;
            let adSlateLength = parseInt(programme.getElementsByTagName('ad_slate_length')[0].textContent);
            const originalAdSlateLength = adSlateLength; 
            const applied_rules = programme.getElementsByTagName('applied_rules')[0]?.textContent || ''; 

            const row = document.createElement('tr');
            row.draggable = true;
			row.classList.add('draggable'); // Add draggable class
            row.dataset.movieId = movieId; 
            row.dataset.duration = duration; 
            row.dataset.adSlateLength = adSlateLength; 
            row.dataset.originalAdSlateLength = originalAdSlateLength; 
            row.dataset.start = start.format('YYYYMMDDHHmmss'); 
            row.dataset.stop = stop.format('YYYYMMDDHHmmss');
            row.dataset.channelId = programme.getAttribute('channel');
            row.dataset.timeslot = getTimeSlotClass(start.format('HH:mm:ss'));
            row.dataset.pcRating = pc_rating;
            row.dataset.genres = genres;
			row.dataset.appliedRules = applied_rules;
            row.dataset.title = title;
            row.dataset.desc = desc;
            row.addEventListener('dragstart', handleDragStart);
            row.addEventListener('dragover', handleDragOver);
            row.addEventListener('dragleave', handleDragLeave);
            row.addEventListener('drop', handleDrop);
            row.addEventListener('dragend', handleDragEnd);

            const timeCell = document.createElement('td');
            timeCell.textContent = `${start.format('HH:mm:ss')} - ${stop.format('HH:mm:ss')}`;
            const timeSlotClass = getTimeSlotClass(start.format('HH:mm:ss'));
            if (timeSlotClass) {
                timeCell.classList.add(timeSlotClass.toLowerCase().replace(' ', '-'));
            }
            row.appendChild(timeCell);
            
            const programCell = document.createElement('td');
            programCell.innerHTML = `
                <strong>${title}</strong><br><br>
                ${desc}<br><br>
                <strong>Genre:</strong> ${genres}<br>
                <strong>PC rating:</strong> ${pc_rating}<br>
                <div class="ad-controls">
                    <span>Gap Filler:</span>
                    <button class="decrease-ad">-1 min</button>
                    <span id="ad-slate-length">${adSlateLength} min</span>
                    <button class="increase-ad">+1 min</button>
                </div>
            `;
            row.appendChild(programCell);

            const rulesCell = document.createElement('td'); 
            rulesCell.innerHTML = applied_rules.split(',').join('<br><br>') || '';
            row.appendChild(rulesCell);

            epgBody.appendChild(row);

            // Whenever there is a activity in + and - buttons of the gap filler, have to update the dragged movie object or the movie to update 
            programCell.querySelector('.decrease-ad').addEventListener('click', function() {
                console.log('Decrease button clicked');
                let adSlateLength = Math.max(0, parseInt(programCell.querySelector('#ad-slate-length').textContent) - 1);
                row.dataset.adSlateLength = adSlateLength;
                programCell.querySelector('#ad-slate-length').textContent = `${adSlateLength} min`;
                recalculateTimeSlots(); 
                validateButton.disabled = false;
                submitButton.disabled = true; 

                // Update the movie object for validation
                draggedMovie = {
                    movieId: row.dataset.movieId,
                    start: row.dataset.start,
                    stop: row.dataset.stop,
                    timeslot: row.dataset.timeslot,
                    pc_rating: row.dataset.pcRating,
                    genres: row.dataset.genres,
                    adSlateLength: row.dataset.adSlateLength
                };
            });

            programCell.querySelector('.increase-ad').addEventListener('click', function() {
                console.log('Increase button clicked');
                let adSlateLength = parseInt(programCell.querySelector('#ad-slate-length').textContent) + 1;
                row.dataset.adSlateLength = adSlateLength;
                programCell.querySelector('#ad-slate-length').textContent = `${adSlateLength} min`;
                recalculateTimeSlots(); 
                validateButton.disabled = false;
                submitButton.disabled = true; 

                // Update the movie object for validation
                draggedMovie = {
                    movieId: row.dataset.movieId,
                    start: row.dataset.start,
                    stop: row.dataset.stop,
                    timeslot: row.dataset.timeslot,
                    pc_rating: row.dataset.pcRating,
                    genres: row.dataset.genres,
                    adSlateLength: row.dataset.adSlateLength
                };
            });
        }
        recalculateTimeSlots(); 
    }

    fetch(`${apiUrl}/fetch_xml`)
        .then(response => response.text())
        .then(data => {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(data, 'application/xml');
            const channels = xmlDoc.getElementsByTagName('channel');
            const programmes = xmlDoc.getElementsByTagName('program');
            const channelSelect = document.getElementById('channel-select');
            const channelHeader = document.getElementById('channel-header');

            // Set the header to "Programs"
            channelHeader.textContent = "Programs";

            // Populate channel dropdown
            for (let channel of channels) {
                const option = document.createElement('option');
                option.value = channel.getAttribute('id');
                option.textContent = channel.getElementsByTagName('display-name')[0].textContent;
                channelSelect.appendChild(option);
            }

            let firstProgramDate = null;
            if (programmes.length > 0) {
                firstProgramDate = moment(programmes[0].getAttribute('start'), 'YYYYMMDDHHmmss').format('YYYY-MM-DD');
            }

            // Event listener for channel selection
            channelSelect.addEventListener('change', function() {
                const selectedChannelId = channelSelect.value;
                const selectedDate = datePicker.value;
                fetchAndUpdateEPG(selectedChannelId, selectedDate);
            });

            datePicker.addEventListener('change', function() {
                const selectedChannelId = channelSelect.value;
                const selectedDate = datePicker.value;
                fetchAndUpdateEPG(selectedChannelId, selectedDate);
            });

            document.getElementById('prev-day-button').addEventListener('click', function() {
                const selectedDate = moment(datePicker.value).subtract(1, 'days').format('YYYY-MM-DD');
                datePicker.value = selectedDate;
                const selectedChannelId = channelSelect.value;
                fetchAndUpdateEPG(selectedChannelId, selectedDate);
            });

            document.getElementById('next-day-button').addEventListener('click', function() {
                const selectedDate = moment(datePicker.value).add(1, 'days').format('YYYY-MM-DD');
                datePicker.value = selectedDate;
                const selectedChannelId = channelSelect.value;
                fetchAndUpdateEPG(selectedChannelId, selectedDate);
            });

            if (channels.length > 0) {
                channelSelect.value = channels[0].getAttribute('id');
                datePicker.value = firstProgramDate || moment().format('YYYY-MM-DD'); 
                fetchAndUpdateEPG(channels[0].getAttribute('id'), datePicker.value);
            }
        })
        .catch(error => console.error('Error fetching XML:', error));

    function handleDragStart(e) {
        e.dataTransfer.setData('text/plain', e.target.rowIndex);
        e.target.classList.add('dragging');
        draggedMovie = {
            movieId: e.target.dataset.movieId,
            start: e.target.dataset.start,
            stop: e.target.dataset.stop,
            timeslot: e.target.dataset.timeslot,
            pc_rating: e.target.dataset.pcRating,
            genres: e.target.dataset.genres,
            adSlateLength: e.target.dataset.adSlateLength
        };
        validateButton.disabled = false;
        submitButton.disabled = true;
    }

    function handleDragOver(e) {
        e.preventDefault();
        const targetRow = e.target.closest('tr');
        if (!targetRow.classList.contains('placeholder')) {
            targetRow.classList.add('dropzone');
        }

        const scrollThreshold = 50; 
        const scrollSpeed = 10; 
        const rect = targetRow.getBoundingClientRect();
        if (rect.bottom > window.innerHeight - scrollThreshold) {
            window.scrollBy(0, scrollSpeed);
        } else if (rect.top < scrollThreshold) {
            window.scrollBy(0, -scrollSpeed);
        }
    }

    function handleDragLeave(e) {
        const targetRow = e.target.closest('tr');
        if (targetRow) {
            targetRow.classList.remove('dropzone');
        }
    }

    function handleDrop(e) {
        e.preventDefault();
        const draggedRowIndex = parseInt(e.dataTransfer.getData('text/plain'));
        const draggedRow = document.getElementById('epg-body').rows[draggedRowIndex - 1];
        const targetRow = e.target.closest('tr');
        const targetRowIndex = targetRow.rowIndex;

        if (draggedRowIndex < targetRowIndex) {
            document.getElementById('epg-body').insertBefore(draggedRow, targetRow.nextSibling);
        } else {
            document.getElementById('epg-body').insertBefore(draggedRow, targetRow);
        }

        document.querySelector('.dragging').classList.remove('dragging');
        document.querySelectorAll('.dropzone').forEach(el => el.classList.remove('dropzone'));

        recalculateTimeSlots(); // Ensure recalculation happens after drop

        // Update the draggedMovie object with the new timeslot
        const newStart = moment(draggedRow.dataset.start, 'YYYYMMDDHHmmss');
        draggedMovie.timeslot = getTimeSlotClass(newStart.format('HH:mm:ss'));

        validateButton.disabled = false;
        submitButton.disabled = true;
    }

    function handleDragEnd() {
        this.classList.remove('dragging');
    }

	validateButton.addEventListener('click', function() {
    const rows = document.getElementById('epg-body').querySelectorAll('tr');
    const schedule = Array.from(rows).map(row => ({
        movieId: row.dataset.movieId,
        start: row.dataset.start,
        stop: row.dataset.stop,
        duration: row.dataset.duration,
        adSlateLength: row.dataset.adSlateLength,
        originalAdSlateLength: row.dataset.originalAdSlateLength,
        additionalAdSlateLength: row.dataset.adSlateLength - row.dataset.originalAdSlateLength, // Calculate additional ad slate length
        channelId: row.dataset.channelId,
        timeslot: row.dataset.timeslot,
        pc_rating: row.dataset.pcRating,
        genres: row.dataset.genres,
        title: row.dataset.title,
        desc: row.dataset.desc,
        applied_rules: row.dataset.appliedRules
    }));
    const payload = { schedule: schedule };
    console.log('Payload:', payload);
    fetch(`${apiUrl}/validate_schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
    .then(response => response.json())
    .then(data => {
        if (data.valid) {
            alert('Schedule is validated.');
            validateButton.disabled = true;
            submitButton.disabled = false;
            document.querySelectorAll('tr').forEach(row => {
                row.classList.remove('invalid-movie');
                const programCell = row.querySelector('td:nth-child(2)');
                const rulesCell = row.querySelector('td:nth-child(3)');
                if (programCell) {
                    programCell.style.backgroundColor = ''; // Reset the program column color
                    programCell.style.color = ''; // Reset the text color
                }
                if (rulesCell) {
                    rulesCell.style.backgroundColor = ''; // Reset the applied_rules column color
                    rulesCell.style.color = ''; // Reset the text color
                }
            });
            updateTimeslotColors(); // Update timeslot colors after validation
        } 
		else {
            let invalidMovies = data.invalidMovies.map(invalidMovie => {
                const row = document.querySelector(`tr[data-movie-id="${invalidMovie.movieId}"]`);
                row.classList.add('invalid-movie');
                const programCell = row.querySelector('td:nth-child(2)');
                const rulesCell = row.querySelector('td:nth-child(3)');
                if (programCell) {
                    programCell.style.backgroundColor = '#ea0808'; // Apply red background color to program column
                    programCell.style.color = '#ffffff'; // Apply white text color
                }
                if (rulesCell) {
                    rulesCell.style.backgroundColor = '#ea0808'; // Apply red background color to rules column
                    rulesCell.style.color = '#ffffff'; // Apply white text color
                }
                return `Title: ${row.dataset.title}, Reason: ${invalidMovie.reason}`;
            });
            // Reset the color for rows that are now valid
            document.querySelectorAll('tr').forEach(row => {
                const movieId = row.dataset.movieId;
                if (!data.invalidMovies.some(invalidMovie => invalidMovie.movieId === movieId)) {
                    row.classList.remove('invalid-movie');
                    const programCell = row.querySelector('td:nth-child(2)');
                    const rulesCell = row.querySelector('td:nth-child(3)');
                    if (programCell) {
                        programCell.style.backgroundColor = ''; // Reset the program column color
                        programCell.style.color = ''; // Reset the text color
                    }
                    if (rulesCell) {
                        rulesCell.style.backgroundColor = ''; // Reset the applied_rules column color
                        rulesCell.style.color = ''; // Reset the text color
                    }
                }
            });
            alert(`Following scheduled are no valid:\n\n${invalidMovies.join('\n\n')}`);
            submitButton.disabled = true;
        }
    })
    .catch(error => console.error('Error validating schedule:', error));
});

	//function iterates through each row and updates the class based on the new timeslot.
	function updateTimeslotColors() {
    const rows = document.getElementById('epg-body').querySelectorAll('tr');
    rows.forEach(row => {
        const start = moment(row.dataset.start, 'YYYYMMDDHHmmss');
        const timeslotClass = getTimeSlotClass(start.format('HH:mm:ss'));
        const timeCell = row.querySelector('td:first-child');
        timeCell.className = ''; // Reset any existing class
        if (timeslotClass) {
            timeCell.classList.add(timeslotClass.toLowerCase().replace(' ', '-'));
        }
    });
}	
	
    submitButton.addEventListener('click', function() {
        recalculateTimeSlots(); // Ensure timeslots are recalculated before submission
        const rows = document.getElementById('epg-body').querySelectorAll('tr');
        const programs = Array.from(rows).map(row => ({
            movieId: row.dataset.movieId,
            start: row.dataset.start,
            stop: row.dataset.stop,
            duration: row.dataset.duration,
            adSlateLength: row.dataset.adSlateLength,
            originalAdSlateLength: row.dataset.originalAdSlateLength,
            additionalAdSlateLength: row.dataset.adSlateLength - row.dataset.originalAdSlateLength, // Calculate additional ad slate length
            channelId: row.dataset.channelId
        }));

        const xmlPayload = createXMLPayload(apiUrl, document.getElementById('channel-select').value, programs);

        fetch(`${apiUrl}/update_schedule`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/xml'
            },
            body: xmlPayload
        })
        .then(response => response.text())
        .then(data => {
            console.log('Schedule updated successfully:', data);
            alert('Schedule updated successfully.');
            submitButton.disabled = true;
        })
        .catch(error => console.error('Error updating schedule:', error));
    });

    function createXMLPayload(apiUrl, channelId, programs) {
        const xmlDoc = document.implementation.createDocument('', '', null);
        const root = xmlDoc.createElement('ScheduleRequest');
        
        const xmlUrlElement = xmlDoc.createElement('xml_url');
        xmlUrlElement.textContent = apiUrl;
        root.appendChild(xmlUrlElement);

        const channelElement = xmlDoc.createElement('channel_id');
        channelElement.textContent = channelId;
        root.appendChild(channelElement);

        const programsElement = xmlDoc.createElement('programs');
        programs.forEach(program => {
            const programElement = xmlDoc.createElement('Program');
            
            const idElement = xmlDoc.createElement('id');
            idElement.textContent = program.movieId;
            programElement.appendChild(idElement);

            const startElement = xmlDoc.createElement('start');
            startElement.textContent = program.start;
            programElement.appendChild(startElement);

            const stopElement = xmlDoc.createElement('stop');
            stopElement.textContent = program.stop;
            programElement.appendChild(stopElement);

            const durationElement = xmlDoc.createElement('duration');
            durationElement.textContent = program.duration;
            programElement.appendChild(durationElement);

            const adSlateLengthElement = xmlDoc.createElement('ad_slate_length');
            adSlateLengthElement.textContent = program.adSlateLength;
            programElement.appendChild(adSlateLengthElement);

            const originalAdSlateLengthElement = xmlDoc.createElement('original_ad_slate_length');
            originalAdSlateLengthElement.textContent = program.originalAdSlateLength;
            programElement.appendChild(originalAdSlateLengthElement);

            const additionalAdSlateLengthElement = xmlDoc.createElement('additional_ad_slate_length');
            additionalAdSlateLengthElement.textContent = program.additionalAdSlateLength;
            programElement.appendChild(additionalAdSlateLengthElement);

            const channelIdElement = xmlDoc.createElement('channel_id');
            channelIdElement.textContent = program.channelId;
            programElement.appendChild(channelIdElement);

            programsElement.appendChild(programElement);
        });
        root.appendChild(programsElement);
        xmlDoc.appendChild(root);
        return new XMLSerializer().serializeToString(xmlDoc);
    }

	// To recalculating the timings when there is a change in order of movies.
    function recalculateTimeSlots() {
        const rows = document.getElementById('epg-body').querySelectorAll('tr');
        let currentTime = moment().startOf('day');

        rows.forEach(row => {
            const duration = parseInt(row.dataset.duration);
            const adSlateLength = parseInt(row.dataset.adSlateLength);
            const originalAdSlateLength = parseInt(row.dataset.originalAdSlateLength);
            const totalDuration = duration + adSlateLength - originalAdSlateLength;
            const start = currentTime.clone();
            const stop = currentTime.add(totalDuration, 'minutes');

            row.dataset.start = start.format('YYYYMMDDHHmmss');
            row.dataset.stop = stop.format('YYYYMMDDHHmmss');
            row.dataset.timeslot = getTimeSlotClass(start.format('HH:mm:ss'));

            const timeCell = row.querySelector('td:first-child');
            timeCell.textContent = `${start.format('HH:mm:ss')} - ${stop.format('HH:mm:ss')}`;
            timeCell.classList.add(getTimeSlotClass(start.format('HH:mm:ss')).toLowerCase().replace(' ', '-'));
        });
    }
});

