from flask import Flask, request, jsonify, send_from_directory, send_file
from flask_cors import CORS
import os
import json
from datetime import datetime, timedelta
import requests
import base64
import io
import tempfile
import sqlite3
import hashlib
import secrets
import uuid
from functools import wraps

try:
    import librosa
    import numpy as np
    HAS_AUDIO_LIBS = True
except ImportError:
    HAS_AUDIO_LIBS = False

try:
    from PyPDF2 import PdfReader
    HAS_PDF = True
except ImportError:
    HAS_PDF = False

try:
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle
    from reportlab.lib.units import inch
    HAS_REPORTLAB = True
except ImportError:
    HAS_REPORTLAB = False

app = Flask(__name__, static_folder='.')
CORS(app)

# Database configuration
DATABASE = 'ai_platform.db'
SESSIONS_TIMEOUT = 24  # hours

# Store session data
sessions = {}
teacher_sessions = {}
temp_file_store = {}
auth_tokens = {}  # token -> user_id mapping

# ============ DATABASE INITIALIZATION ============

def get_db():
    """Get database connection"""
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    """Initialize database schema"""
    conn = get_db()
    cursor = conn.cursor()
    
    # Users table
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        user_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_login TEXT
    )
    ''')
    
    # Question papers table (created by teachers)
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS question_papers (
        id TEXT PRIMARY KEY,
        teacher_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        questions TEXT NOT NULL,
        difficulty TEXT,
        created_at TEXT NOT NULL,
        deadline TEXT,
        FOREIGN KEY (teacher_id) REFERENCES users(id)
    )
    ''')
    
    # Paper assignments table
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS assignments (
        id TEXT PRIMARY KEY,
        paper_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        assigned_at TEXT NOT NULL,
        deadline TEXT,
        status TEXT DEFAULT 'pending',
        FOREIGN KEY (paper_id) REFERENCES question_papers(id),
        FOREIGN KEY (student_id) REFERENCES users(id)
    )
    ''')
    
    # Student answers table
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS student_answers (
        id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        paper_id TEXT NOT NULL,
        answers TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        graded INTEGER DEFAULT 0,
        grade TEXT,
        feedback TEXT,
        FOREIGN KEY (assignment_id) REFERENCES assignments(id),
        FOREIGN KEY (student_id) REFERENCES users(id),
        FOREIGN KEY (paper_id) REFERENCES question_papers(id)
    )
    ''')
    
    # Interview sessions table
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS interview_sessions (
        id TEXT PRIMARY KEY,
        student_id TEXT NOT NULL,
        interview_type TEXT,
        difficulty TEXT,
        conversation_history TEXT,
        stats TEXT,
        created_at TEXT,
        duration INTEGER DEFAULT 0,
        FOREIGN KEY (student_id) REFERENCES users(id)
    )
    ''')
    
    # Interactive learning sessions table
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS learning_sessions (
        id TEXT PRIMARY KEY,
        student_id TEXT NOT NULL,
        topic TEXT,
        content TEXT,
        audio_recordings TEXT,
        created_at TEXT,
        FOREIGN KEY (student_id) REFERENCES users(id)
    )
    ''')
    
    conn.commit()
    conn.close()

def hash_password(password):
    """Hash password using SHA256"""
    return hashlib.sha256(password.encode()).hexdigest()

def generate_token():
    """Generate secure token"""
    return secrets.token_urlsafe(32)

def generate_uuid():
    """Generate UUID"""
    return str(uuid.uuid4())

# Initialize database on startup
init_db()

# ============ AUTHENTICATION MIDDLEWARE ============

def require_auth(f):
    """Decorator to require authentication"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        token = request.headers.get('Authorization', '').replace('Bearer ', '')
        
        if not token or token not in auth_tokens:
            return jsonify({'error': 'Unauthorized'}), 401
        
        user_id = auth_tokens[token]
        request.user_id = user_id
        return f(*args, **kwargs)
    
    return decorated_function

def require_teacher(f):
    """Decorator to require teacher role"""
    @wraps(f)
    @require_auth
    def decorated_function(*args, **kwargs):
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT user_type FROM users WHERE id = ?', (request.user_id,))
        user = cursor.fetchone()
        conn.close()
        
        if not user or user['user_type'] != 'teacher':
            return jsonify({'error': 'Teacher access required'}), 403
        
        return f(*args, **kwargs)
    
    return decorated_function

def require_student(f):
    """Decorator to require student role"""
    @wraps(f)
    @require_auth
    def decorated_function(*args, **kwargs):
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT user_type FROM users WHERE id = ?', (request.user_id,))
        user = cursor.fetchone()
        conn.close()
        
        if not user or user['user_type'] != 'student':
            return jsonify({'error': 'Student access required'}), 403
        
        return f(*args, **kwargs)
    
    return decorated_function

# ============ STATIC FILE SERVING ============

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory('.', path)

# ============ AUTHENTICATION ENDPOINTS ============

@app.route('/api/auth/register', methods=['POST'])
def register():
    """Register new user"""
    try:
        data = request.json
        username = data.get('username', '').strip()
        email = data.get('email', '').strip()
        password = data.get('password', '')
        user_type = data.get('user_type', 'student')  # 'student' or 'teacher'
        
        # Validation
        if not username or not email or not password:
            return jsonify({'error': 'Missing required fields'}), 400
        
        if len(password) < 6:
            return jsonify({'error': 'Password must be at least 6 characters'}), 400
        
        if user_type not in ['student', 'teacher']:
            return jsonify({'error': 'Invalid user type'}), 400
        
        conn = get_db()
        cursor = conn.cursor()
        
        # Check if user exists
        cursor.execute('SELECT id FROM users WHERE username = ? OR email = ?', (username, email))
        if cursor.fetchone():
            conn.close()
            return jsonify({'error': 'Username or email already exists'}), 409
        
        # Create new user
        user_id = generate_uuid()
        password_hash = hash_password(password)
        created_at = datetime.now().isoformat()
        
        cursor.execute('''
        INSERT INTO users (id, username, email, password_hash, user_type, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ''', (user_id, username, email, password_hash, user_type, created_at))
        
        conn.commit()
        conn.close()
        
        return jsonify({
            'success': True,
            'message': 'User registered successfully',
            'user_id': user_id,
            'user_type': user_type
        }), 201
        
    except Exception as e:
        print(f"[DEBUG] Registration error: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/auth/login', methods=['POST'])
def login():
    """Login user and return auth token"""
    try:
        data = request.json
        username_or_email = data.get('username', '').strip()
        password = data.get('password', '')
        
        if not username_or_email or not password:
            return jsonify({'error': 'Missing username and password'}), 400
        
        conn = get_db()
        cursor = conn.cursor()
        
        cursor.execute('''
        SELECT id, username, user_type, password_hash FROM users 
        WHERE username = ? OR email = ?
        ''', (username_or_email, username_or_email))
        
        user = cursor.fetchone()
        conn.close()
        
        if not user or user['password_hash'] != hash_password(password):
            return jsonify({'error': 'Invalid username or password'}), 401
        
        # Generate and store token
        token = generate_token()
        auth_tokens[token] = user['id']
        
        return jsonify({
            'success': True,
            'token': token,
            'user_id': user['id'],
            'username': user['username'],
            'user_type': user['user_type']
        }), 200
        
    except Exception as e:
        print(f"[DEBUG] Login error: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/auth/logout', methods=['POST'])
@require_auth
def logout():
    """Logout user"""
    try:
        token = request.headers.get('Authorization', '').replace('Bearer ', '')
        if token in auth_tokens:
            del auth_tokens[token]
        return jsonify({'success': True, 'message': 'Logged out successfully'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/auth/verify', methods=['GET'])
@require_auth
def verify_token():
    """Verify token and get user info"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT id, username, email, user_type FROM users WHERE id = ?', (request.user_id,))
        user = cursor.fetchone()
        conn.close()
        
        if not user:
            return jsonify({'error': 'User not found'}), 404
        
        return jsonify({
            'valid': True,
            'user_id': user['id'],
            'username': user['username'],
            'email': user['email'],
            'user_type': user['user_type']
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/test-key', methods=['POST'])
def test_api_key():
    """Test if the Gemini API key is valid"""
    try:
        data = request.json
        api_key = data.get('api_key')
        
        if not api_key:
            return jsonify({'valid': False, 'error': 'No API key provided'}), 400
        
        # Test the API key with a simple request
        url = f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}'
        response = requests.post(
            url,
            json={
                'contents': [{
                    'parts': [{'text': 'test'}]
                }],
                'generationConfig': {
                    'temperature': 0.1,
                    'maxOutputTokens': 10,
                }
            },
            timeout=10
        )
        
        print(f"[DEBUG] Test API status: {response.status_code}")
        
        if response.status_code == 200:
            return jsonify({'valid': True})
        elif response.status_code == 400 or response.status_code == 401:
            try:
                error_data = response.json()
                error_msg = error_data.get('error', {}).get('message', 'Invalid API key')
            except:
                error_msg = response.text
            return jsonify({'valid': False, 'error': error_msg}), 400
        else:
            return jsonify({'valid': False, 'error': f'API returned status {response.status_code}'}), 400
            
    except requests.exceptions.Timeout:
        return jsonify({'valid': False, 'error': 'Request timeout'}), 500
    except requests.exceptions.RequestException as e:
        return jsonify({'valid': False, 'error': f'Network error: {str(e)}'}), 500
    except Exception as e:
        return jsonify({'valid': False, 'error': str(e)}), 500

@app.route('/api/generate', methods=['POST'])
def generate_response():
    """Generate AI response using Gemini API"""
    try:
        data = request.json
        api_key = data.get('api_key')
        prompt = data.get('prompt')
        conversation_history = data.get('history', [])
        
        if not api_key or not prompt:
            return jsonify({'error': 'Missing required fields'}), 400
        
        # Prepare the request to Gemini API
        url = f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}'
        
        # Build conversation context
        full_prompt = prompt
        if conversation_history:
            context = '\n'.join([f"{msg['role']}: {msg['content']}" for msg in conversation_history[-5:]])
            full_prompt = f"Previous conversation:\n{context}\n\n{prompt}"
        
        response = requests.post(
            url,
            json={
                'contents': [{
                    'parts': [{'text': full_prompt}]
                }],
                'generationConfig': {
                    'temperature': 0.7,
                    'maxOutputTokens': 2000,
                }
            },
            timeout=30
        )
        
        print(f"[DEBUG] Generate API status: {response.status_code}")
        print(f"[DEBUG] Generate API response: {response.text[:500]}")
        
        if response.status_code != 200:
            error_data = response.json() if response.text else {}
            error_msg = error_data.get('error', {}).get('message', f'API error: {response.status_code}')
            print(f"[DEBUG] Error: {error_msg}")
            return jsonify({'error': f'API request failed: {error_msg}', 'details': response.text}), 500
        
        result = response.json()
        ai_response = result['candidates'][0]['content']['parts'][0]['text']
        
        return jsonify({
            'response': ai_response,
            'success': True
        })
        
    except Exception as e:
        print(f"[DEBUG] Exception in generate: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/session/create', methods=['POST'])
def create_session():
    """Create a new interview session"""
    try:
        data = request.json
        session_id = f"session_{datetime.now().timestamp()}"
        
        sessions[session_id] = {
            'id': session_id,
            'created_at': datetime.now().isoformat(),
            'interview_type': data.get('interview_type', 'technical'),
            'difficulty': data.get('difficulty', 'medium'),
            'conversation_history': [],
            'stats': {
                'questions_asked': 0,
                'corrections_made': 0,
                'duration': 0
            }
        }
        
        return jsonify({
            'session_id': session_id,
            'success': True
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/session/<session_id>', methods=['GET'])
def get_session(session_id):
    """Get session details"""
    if session_id not in sessions:
        return jsonify({'error': 'Session not found'}), 404
    
    return jsonify(sessions[session_id])

@app.route('/api/session/<session_id>/update', methods=['POST'])
def update_session(session_id):
    """Update session data"""
    try:
        if session_id not in sessions:
            return jsonify({'error': 'Session not found'}), 404
        
        data = request.json
        
        if 'conversation_history' in data:
            sessions[session_id]['conversation_history'].append(data['conversation_history'])
        
        if 'stats' in data:
            sessions[session_id]['stats'].update(data['stats'])
        
        return jsonify({
            'success': True,
            'session': sessions[session_id]
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/analyze-response', methods=['POST'])
def analyze_response():
    """Analyze user's response and provide corrections"""
    try:
        data = request.json
        user_response = data.get('response')
        api_key = data.get('api_key')
        context = data.get('context', '')
        
        if not user_response or not api_key:
            return jsonify({'error': 'Missing required fields'}), 400
        
        # Create analysis prompt
        analysis_prompt = f"""Analyze the following interview response and provide constructive feedback:

Context: {context}
Response: "{user_response}"

Please evaluate:
1. Grammar and language usage
2. Clarity and structure
3. Completeness of the answer
4. Key points that might be missing
5. Overall effectiveness

Provide specific, actionable feedback. If there are errors or areas for improvement, start with "Correction: " followed by the specific issue and how to fix it.
"""
        
        url = f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}'
        response = requests.post(
            url,
            json={
                'contents': [{
                    'parts': [{'text': analysis_prompt}]
                }],
                'generationConfig': {
                    'temperature': 0.7,
                    'maxOutputTokens': 800,
                }
            },
            timeout=30
        )
        
        if response.status_code != 200:
            return jsonify({'error': 'Analysis failed'}), 500
        
        result = response.json()
        analysis = result['candidates'][0]['content']['parts'][0]['text']
        
        # Check if there are corrections
        has_corrections = 'correction:' in analysis.lower()
        
        return jsonify({
            'analysis': analysis,
            'has_corrections': has_corrections,
            'success': True
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.now().isoformat(),
        'active_sessions': len(sessions)
    })

# ============ TEACHER ENDPOINTS ============

@app.route('/api/teacher/create-assignment', methods=['POST'])
@require_teacher
def create_assignment():
    """Teacher creates question paper and assigns to students"""
    try:
        data = request.json
        student_ids = data.get('student_ids', [])  # List of student IDs or usernames/emails
        title = data.get('title', '')
        description = data.get('description', '')
        questions = data.get('questions', [])  # List of question objects
        difficulty = data.get('difficulty', 'medium')
        deadline = data.get('deadline', None)
        api_key = data.get('api_key', '')
        
        if not student_ids or not questions:
            return jsonify({'error': 'Missing students or questions'}), 400

        # Resolve provided student identifiers (allow IDs, usernames or emails)
        conn = get_db()
        cursor = conn.cursor()
        resolved_student_ids = []
        skipped = []
        for ident in student_ids:
            # Try direct id match first
            cursor.execute('SELECT id, user_type FROM users WHERE id = ?', (ident,))
            row = cursor.fetchone()
            if row and row['user_type'] == 'student':
                resolved_student_ids.append(row['id'])
                continue

            # Try username or email
            cursor.execute('SELECT id, user_type FROM users WHERE username = ? OR email = ?', (ident, ident))
            row = cursor.fetchone()
            if row and row['user_type'] == 'student':
                resolved_student_ids.append(row['id'])
                continue

            skipped.append(str(ident))

        # Create question paper
        paper_id = generate_uuid()
        created_at = datetime.now().isoformat()

        cursor.execute('''
        INSERT INTO question_papers (id, teacher_id, title, description, questions, difficulty, created_at, deadline)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''', (paper_id, request.user_id, title, description, json.dumps(questions), difficulty, created_at, deadline))

        # Create assignments for each resolved student
        assignment_ids = []
        for student_id in resolved_student_ids:
            assignment_id = generate_uuid()
            assigned_at = datetime.now().isoformat()

            cursor.execute('''
            INSERT INTO assignments (id, paper_id, student_id, assigned_at, deadline, status)
            VALUES (?, ?, ?, ?, ?, 'pending')
            ''', (assignment_id, paper_id, student_id, assigned_at, deadline))

            assignment_ids.append(assignment_id)

        conn.commit()
        conn.close()

        msg = f'Assignment created and assigned to {len(assignment_ids)} students'
        if skipped:
            msg += f". Skipped identifiers: {', '.join(skipped)}"

        return jsonify({
            'success': True,
            'paper_id': paper_id,
            'assignment_ids': assignment_ids,
            'skipped': skipped,
            'message': msg
        }), 201
        
    except Exception as e:
        print(f"[DEBUG] Error creating assignment: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/teacher/papers', methods=['GET'])
@require_teacher
def get_teacher_papers():
    """Get all question papers created by teacher"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        
        cursor.execute('''
        SELECT id, title, description, difficulty, created_at, deadline
        FROM question_papers
        WHERE teacher_id = ?
        ORDER BY created_at DESC
        ''', (request.user_id,))
        
        papers = [dict(row) for row in cursor.fetchall()]
        
        # Get submission stats for each paper
        for paper in papers:
            cursor.execute('''
            SELECT COUNT(*) as total_assigned, 
                   SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) as submitted,
                   SUM(CASE WHEN status = 'graded' THEN 1 ELSE 0 END) as graded
            FROM assignments WHERE paper_id = ?
            ''', (paper['id'],))
            
            stats = cursor.fetchone()
            paper['total_assigned'] = stats['total_assigned'] or 0
            paper['submitted'] = stats['submitted'] or 0
            paper['graded'] = stats['graded'] or 0
        
        conn.close()
        
        return jsonify({
            'success': True,
            'papers': papers
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/teacher/submissions/<paper_id>', methods=['GET'])
@require_teacher
def get_submissions(paper_id):
    """Get all submissions for a paper"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        
        # Verify teacher owns this paper
        cursor.execute('SELECT teacher_id FROM question_papers WHERE id = ?', (paper_id,))
        paper = cursor.fetchone()
        
        if not paper or paper['teacher_id'] != request.user_id:
            conn.close()
            return jsonify({'error': 'Unauthorized'}), 403
        
        # Get submissions
        cursor.execute('''
        SELECT sa.id, sa.student_id, u.username, sa.submitted_at, sa.graded, sa.grade
        FROM student_answers sa
        JOIN users u ON sa.student_id = u.id
        WHERE sa.paper_id = ?
        ORDER BY sa.submitted_at DESC
        ''', (paper_id,))
        
        submissions = [dict(row) for row in cursor.fetchall()]
        conn.close()
        
        return jsonify({
            'success': True,
            'submissions': submissions
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/teacher/grade', methods=['POST'])
@require_teacher
def grade_submission():
    """Grade a student submission"""
    try:
        data = request.json
        answer_id = data.get('answer_id')
        grade = data.get('grade')
        feedback = data.get('feedback')
        api_key = data.get('api_key')
        
        conn = get_db()
        cursor = conn.cursor()
        
        # Get the answer and verify access
        cursor.execute('''
        SELECT sa.id, sa.paper_id, qp.teacher_id FROM student_answers sa
        JOIN question_papers qp ON sa.paper_id = qp.id
        WHERE sa.id = ?
        ''', (answer_id,))
        
        answer = cursor.fetchone()
        if not answer or answer['teacher_id'] != request.user_id:
            conn.close()
            return jsonify({'error': 'Unauthorized'}), 403
        
        # Update with grade
        cursor.execute('''
        UPDATE student_answers
        SET graded = 1, grade = ?, feedback = ?
        WHERE id = ?
        ''', (grade, feedback, answer_id))
        
        # Update assignment status
        cursor.execute('''
        UPDATE assignments SET status = 'graded'
        WHERE paper_id = ? AND student_id = (
            SELECT student_id FROM student_answers WHERE id = ?
        )
        ''', (answer['paper_id'], answer_id))
        
        conn.commit()
        conn.close()
        
        return jsonify({
            'success': True,
            'message': 'Submission graded successfully'
        }), 200
        
    except Exception as e:
        print(f"[DEBUG] Grading error: {str(e)}")
        return jsonify({'error': str(e)}), 500

# ============ STUDENT ENDPOINTS ============

@app.route('/api/student/assignments', methods=['GET'])
@require_student
def get_assignments():
    """Get all assignments for student"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        
        cursor.execute('''
        SELECT a.id, a.paper_id, qp.title, qp.description, qp.difficulty, 
               a.assigned_at, a.deadline, a.status, u.username as teacher_name,
               qp.questions
        FROM assignments a
        JOIN question_papers qp ON a.paper_id = qp.id
        JOIN users u ON qp.teacher_id = u.id
        WHERE a.student_id = ?
        ORDER BY a.assigned_at DESC
        ''', (request.user_id,))
        
        assignments = []
        for row in cursor.fetchall():
            assignment = dict(row)
            assignment['questions'] = json.loads(assignment['questions'])
            assignments.append(assignment)
        
        conn.close()
        
        return jsonify({
            'success': True,
            'assignments': assignments
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/student/submit-answers', methods=['POST'])
@require_student
def submit_answers():
    """Submit answers for an assignment"""
    try:
        data = request.json
        assignment_id = data.get('assignment_id')
        answers = data.get('answers', {})  # dict of question_id -> answer
        
        conn = get_db()
        cursor = conn.cursor()
        
        # Get assignment details
        cursor.execute('''
        SELECT paper_id FROM assignments WHERE id = ? AND student_id = ?
        ''', (assignment_id, request.user_id))
        
        assignment = cursor.fetchone()
        if not assignment:
            conn.close()
            return jsonify({'error': 'Assignment not found'}), 404
        
        # Create answer submission
        answer_id = generate_uuid()
        submitted_at = datetime.now().isoformat()
        
        cursor.execute('''
        INSERT INTO student_answers 
        (id, assignment_id, student_id, paper_id, answers, submitted_at, graded)
        VALUES (?, ?, ?, ?, ?, ?, 0)
        ''', (answer_id, assignment_id, request.user_id, assignment['paper_id'], 
              json.dumps(answers), submitted_at))
        
        # Update assignment status
        cursor.execute('''
        UPDATE assignments SET status = 'submitted' WHERE id = ?
        ''', (assignment_id,))
        
        conn.commit()
        conn.close()
        
        return jsonify({
            'success': True,
            'answer_id': answer_id,
            'message': 'Answers submitted successfully'
        }), 201
        
    except Exception as e:
        print(f"[DEBUG] Submit answers error: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/student/submissions', methods=['GET'])
@require_student
def get_student_submissions():
    """Get all submissions by student"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        
        cursor.execute('''
        SELECT sa.id, sa.paper_id, qp.title, sa.submitted_at, sa.graded, sa.grade, sa.feedback
        FROM student_answers sa
        JOIN question_papers qp ON sa.paper_id = qp.id
        WHERE sa.student_id = ?
        ORDER BY sa.submitted_at DESC
        ''', (request.user_id,))
        
        submissions = [dict(row) for row in cursor.fetchall()]
        conn.close()
        
        return jsonify({
            'success': True,
            'submissions': submissions
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/student/paper-by-assignment/<assignment_id>', methods=['GET'])
@require_student
def get_paper_by_assignment(assignment_id):
    """Return question paper details for an assignment belonging to the student"""
    try:
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute('SELECT paper_id FROM assignments WHERE id = ? AND student_id = ?', (assignment_id, request.user_id))
        a = cursor.fetchone()
        if not a:
            conn.close()
            return jsonify({'error': 'Assignment not found'}), 404

        paper_id = a['paper_id']
        cursor.execute('SELECT id, title, description, questions, difficulty, created_at FROM question_papers WHERE id = ?', (paper_id,))
        paper = cursor.fetchone()
        conn.close()

        if not paper:
            return jsonify({'error': 'Paper not found'}), 404

        paper = dict(paper)
        try:
            paper['questions'] = json.loads(paper['questions'])
        except Exception:
            paper['questions'] = paper.get('questions')

        return jsonify({'success': True, 'paper': paper}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/student/download-paper/<assignment_id>', methods=['GET'])
@require_student
def download_paper_for_assignment(assignment_id):
    """Generate and return a PDF of the question paper for a specific assignment"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT paper_id FROM assignments WHERE id = ? AND student_id = ?', (assignment_id, request.user_id))
        a = cursor.fetchone()
        if not a:
            conn.close()
            return jsonify({'error': 'Assignment not found'}), 404

        paper_id = a['paper_id']
        cursor.execute('SELECT title, questions FROM question_papers WHERE id = ?', (paper_id,))
        paper = cursor.fetchone()
        conn.close()

        if not paper:
            return jsonify({'error': 'Paper not found'}), 404

        title = paper['title']
        try:
            questions = json.loads(paper['questions'])
            text = ''
            for i, q in enumerate(questions, start=1):
                text += f"Q{i}. {q.get('text', str(q))}\n\n"
        except Exception:
            text = str(paper['questions'])

        if not HAS_REPORTLAB:
            return jsonify({'error': 'PDF generation not available on server'}), 500

        buffer = io.BytesIO()
        doc = SimpleDocTemplate(buffer, pagesize=letter)
        styles = getSampleStyleSheet()
        story = []
        story.append(Paragraph(title, styles['Heading1']))
        story.append(Spacer(1, 12))

        for line in text.split('\n'):
            if line.strip() == '':
                story.append(Spacer(1, 6))
            else:
                story.append(Paragraph(line.replace('\n', '<br/>'), styles['BodyText']))

        doc.build(story)
        buffer.seek(0)

        return send_file(buffer, as_attachment=True, download_name=f"{paper_id}.pdf", mimetype='application/pdf')
    except Exception as e:
        print(f"[DEBUG] download_paper error: {str(e)}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/student/submit-pdf', methods=['POST'])
@require_student
def submit_pdf():
    """Allow student to submit a PDF file for an assignment (multipart/form-data)"""
    try:
        if 'assignment_id' not in request.form:
            return jsonify({'error': 'Missing assignment_id'}), 400

        assignment_id = request.form.get('assignment_id')
        if 'submission' not in request.files:
            return jsonify({'error': 'Missing submission file'}), 400

        file = request.files['submission']
        if file.filename == '':
            return jsonify({'error': 'No file selected'}), 400

        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('SELECT paper_id, status FROM assignments WHERE id = ? AND student_id = ?', (assignment_id, request.user_id))
        a = cursor.fetchone()
        if not a:
            conn.close()
            return jsonify({'error': 'Assignment not found'}), 404

        # Save file to uploads directory
        upload_dir = os.path.join(os.getcwd(), 'uploads', 'submissions')
        os.makedirs(upload_dir, exist_ok=True)
        safe_name = f"{assignment_id}_{int(datetime.now().timestamp())}_{file.filename}"
        save_path = os.path.join(upload_dir, safe_name)
        file.save(save_path)

        # Check if a submission already exists for this assignment
        cursor.execute('SELECT id FROM student_answers WHERE assignment_id = ? AND student_id = ?', (assignment_id, request.user_id))
        existing = cursor.fetchone()
        submitted_at = datetime.now().isoformat()
        answers_payload = json.dumps({'file_path': save_path})

        if existing:
            # Update existing submission
            answer_id = existing['id']
            cursor.execute('''
            UPDATE student_answers SET answers = ?, submitted_at = ?, graded = 0 WHERE id = ?
            ''', (answers_payload, submitted_at, answer_id))
        else:
            answer_id = generate_uuid()
            cursor.execute('''
            INSERT INTO student_answers (id, assignment_id, student_id, paper_id, answers, submitted_at, graded)
            VALUES (?, ?, ?, ?, ?, ?, 0)
            ''', (answer_id, assignment_id, request.user_id, a['paper_id'], answers_payload, submitted_at))

        # Update assignment status
        cursor.execute('UPDATE assignments SET status = "submitted" WHERE id = ?', (assignment_id,))
        # Attempt auto-grading if api_key provided
        api_key = request.form.get('api_key')
        grading_info = None
        try:
            if api_key:
                # Extract text from PDF submission
                try:
                    with open(save_path, 'rb') as f:
                        pdf_bytes = f.read()
                    transcript, err = extract_text_from_pdf(io.BytesIO(pdf_bytes))
                except Exception:
                    transcript, err = None, 'Failed to extract text'

                # Get paper questions to provide context
                cursor.execute('SELECT questions FROM question_papers WHERE id = ?', (a['paper_id'],))
                qp = cursor.fetchone()
                questions = []
                try:
                    if qp and qp['questions']:
                        questions = json.loads(qp['questions'])
                except Exception:
                    questions = []

                # Build grading prompt
                q_text = ''
                for i, q in enumerate(questions, start=1):
                    qbody = q.get('text') if isinstance(q, dict) else str(q)
                    q_text += f"Question {i}: {qbody}\n"

                student_text = transcript or 'Student submission text could not be extracted from PDF.'

                grade_prompt = f"""You are an expert teacher. Grade the student's submission based on the questions below.

QUESTIONS:\n{q_text}\nSTUDENT_SUBMISSION:\n{student_text[:8000]}\n\nFor each question, provide a SCORE out of 10 and constructive FEEDBACK. Then provide an overall SCORE summary line in the format:
OVERALL_SCORE: [X/10]
Provide results in plain text with the OVERALL_SCORE line included."""

                url = f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}'
                resp = requests.post(
                    url,
                    json={
                        'contents': [{ 'parts': [{'text': grade_prompt}] }],
                        'generationConfig': {'temperature': 0.3, 'maxOutputTokens': 1600}
                    },
                    timeout=30
                )

                if resp.status_code == 200:
                    res = resp.json()
                    grading_text = res['candidates'][0]['content']['parts'][0]['text']
                    # Parse overall score if present
                    overall = 'N/A'
                    try:
                        if 'OVERALL_SCORE:' in grading_text:
                            overall = grading_text.split('OVERALL_SCORE:')[1].split('\n')[0].strip()
                        elif 'SCORE:' in grading_text:
                            overall = grading_text.split('SCORE:')[1].split('\n')[0].strip()
                    except Exception:
                        overall = 'N/A'

                    # Update submission with grading
                    cursor.execute('''
                    UPDATE student_answers SET graded = 1, grade = ?, feedback = ? WHERE id = ?
                    ''', (overall, grading_text, answer_id))
                    cursor.execute('UPDATE assignments SET status = "graded" WHERE id = ?', (assignment_id,))
                    conn.commit()
                    grading_info = {'grade': overall, 'feedback': grading_text}
        except Exception as e:
            print(f"[DEBUG] Auto-grading failed: {str(e)}")

        conn.commit()
        conn.close()

        resp_payload = {'success': True, 'answer_id': answer_id, 'message': 'PDF submitted successfully'}
        if grading_info:
            resp_payload['grading'] = grading_info

        return jsonify(resp_payload), 201
    except Exception as e:
        print(f"[DEBUG] submit_pdf error: {str(e)}")
        return jsonify({'error': str(e)}), 500
@app.route('/api/student/submission/<submission_id>', methods=['GET'])
@require_student
def get_submission_details(submission_id):
    """Get detailed view of student submission"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        
        cursor.execute('''
        SELECT sa.id, sa.answers, sa.grade, sa.feedback, qp.questions, qp.title
        FROM student_answers sa
        JOIN question_papers qp ON sa.paper_id = qp.id
        WHERE sa.id = ? AND sa.student_id = ?
        ''', (submission_id, request.user_id))
        
        submission = cursor.fetchone()
        conn.close()
        
        if not submission:
            return jsonify({'error': 'Submission not found'}), 404
        
        submission = dict(submission)
        submission['answers'] = json.loads(submission['answers'])
        submission['questions'] = json.loads(submission['questions'])
        
        return jsonify({
            'success': True,
            'submission': submission
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ============ TEACHER MODE ENDPOINTS ============

def extract_text_from_pdf(pdf_file):
    """Extract text from PDF file"""
    try:
        if not HAS_PDF:
            return None, "PyPDF2 not installed"
        
        pdf_reader = PdfReader(pdf_file)
        text = ""
        for page in pdf_reader.pages:
            text += page.extract_text() + "\n"
        return text, None
    except Exception as e:
        return None, str(e)

@app.route('/api/teacher/session/create', methods=['POST'])
def create_teacher_session():
    """Create a new teacher session with uploaded PDFs"""
    try:
        session_id = f"teacher_{datetime.now().timestamp()}"
        
        # Handle file uploads
        syllabus_text = ""
        pyq_text = ""
        
        if 'syllabus' in request.files:
            syllabus_file = request.files['syllabus']
            text, error = extract_text_from_pdf(io.BytesIO(syllabus_file.read()))
            if text:
                syllabus_text = text
        
        if 'pyq' in request.files:
            pyq_file = request.files['pyq']
            text, error = extract_text_from_pdf(io.BytesIO(pyq_file.read()))
            if text:
                pyq_text = text
        
        teacher_sessions[session_id] = {
            'id': session_id,
            'created_at': datetime.now().isoformat(),
            'syllabus': syllabus_text,
            'pyq': pyq_text,
            'conversation_history': [],
            'generated_papers': [],
            'graded_answers': [],
            'stats': {
                'questions_asked': 0,
                'papers_generated': 0,
                'answers_graded': 0
            }
        }
        
        return jsonify({
            'session_id': session_id,
            'success': True,
            'content_loaded': bool(syllabus_text or pyq_text)
        })
        
    except Exception as e:
        print(f"[DEBUG] Error creating teacher session: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/teacher/teach', methods=['POST'])
def teach_mode():
    """Interactive teaching mode - answer questions about content"""
    try:
        data = request.json
        session_id = data.get('session_id')
        user_question = data.get('question')
        api_key = data.get('api_key')
        
        if session_id not in teacher_sessions:
            return jsonify({'error': 'Session not found'}), 404
        
        session = teacher_sessions[session_id]
        content = f"Syllabus:\n{session['syllabus']}\n\nPrevious Year Questions:\n{session['pyq']}"
        
        # Create teaching prompt
        teach_prompt = f"""You are an expert teacher. Based on the following educational content, answer the student's question clearly and comprehensively.

EDUCATIONAL CONTENT:
{content[:5000]}  # Limit context to avoid token limits

STUDENT QUESTION: {user_question}

Provide a clear, educational response that:
1. Directly answers the question
2. Provides relevant examples from the content
3. Explains concepts in simple terms
4. Suggests related topics to explore"""
        
        url = f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}'
        response = requests.post(
            url,
            json={
                'contents': [{
                    'parts': [{'text': teach_prompt}]
                }],
                'generationConfig': {
                    'temperature': 0.7,
                    'maxOutputTokens': 2000,
                }
            },
            timeout=30
        )
        
        if response.status_code != 200:
            return jsonify({'error': 'Failed to generate response'}), 500
        
        result = response.json()
        ai_response = result['candidates'][0]['content']['parts'][0]['text']
        
        # Store in conversation history
        session['conversation_history'].append({
            'role': 'student',
            'content': user_question
        })
        session['conversation_history'].append({
            'role': 'teacher',
            'content': ai_response
        })
        session['stats']['questions_asked'] += 1
        
        return jsonify({
            'response': ai_response,
            'success': True
        })
        
    except Exception as e:
        print(f"[DEBUG] Error in teach mode: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/teacher/generate-paper', methods=['POST'])
def generate_question_paper():
    """Generate a question paper based on syllabus and PYQs"""
    try:
        data = request.json
        session_id = data.get('session_id')
        num_questions = data.get('num_questions', 10)
        difficulty = data.get('difficulty', 'medium')
        api_key = data.get('api_key')
        question_types = data.get('question_types', ['short', 'long', 'multiple'])
        
        if session_id not in teacher_sessions:
            return jsonify({'error': 'Session not found'}), 404
        
        session = teacher_sessions[session_id]
        content = f"Syllabus:\n{session['syllabus']}\n\nPrevious Year Questions:\n{session['pyq']}"
        
        # Create paper generation prompt
        paper_prompt = f"""You are an expert question paper creator. Based on the provided educational content, create {num_questions} questions of {difficulty} difficulty level.

EDUCATIONAL CONTENT:
{content[:5000]}

REQUIREMENTS:
- Create {num_questions} questions
- Difficulty: {difficulty} (easy/medium/hard)
- Include these types: {', '.join(question_types)}
- Format each question clearly with:
  * Question number
  * Question text
  * For MCQ: A) B) C) D) options
  * Marks: (for reference)

Ensure questions cover important topics from the content and progressively test understanding.

FORMAT YOUR RESPONSE AS:
===QUESTION PAPER===
[Question 1]
[Question 2]
... etc
===END PAPER==="""
        
        url = f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}'
        response = requests.post(
            url,
            json={
                'contents': [{
                    'parts': [{'text': paper_prompt}]
                }],
                'generationConfig': {
                    'temperature': 0.8,
                    'maxOutputTokens': 3000,
                }
            },
            timeout=30
        )
        
        if response.status_code != 200:
            return jsonify({'error': 'Failed to generate paper'}), 500
        
        result = response.json()
        paper_content = result['candidates'][0]['content']['parts'][0]['text']
        
        paper_id = f"paper_{datetime.now().timestamp()}"
        session['generated_papers'].append({
            'id': paper_id,
            'created_at': datetime.now().isoformat(),
            'content': paper_content,
            'num_questions': num_questions,
            'difficulty': difficulty
        })
        session['stats']['papers_generated'] += 1
        
        return jsonify({
            'paper_id': paper_id,
            'content': paper_content,
            'success': True
        })
        
    except Exception as e:
        print(f"[DEBUG] Error generating paper: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/teacher/grade-answer', methods=['POST'])
def grade_answer():
    """Grade a student's answer"""
    try:
        data = request.json
        session_id = data.get('session_id')
        student_name = data.get('student_name', 'Anonymous')
        question = data.get('question')
        answer = data.get('answer')
        api_key = data.get('api_key')
        expected_answer = data.get('expected_answer', '')
        
        if session_id not in teacher_sessions:
            return jsonify({'error': 'Session not found'}), 404
        
        session = teacher_sessions[session_id]
        
        # Create grading prompt
        grade_prompt = f"""You are an expert teacher grading a student's answer. Evaluate the following response and provide detailed feedback.

QUESTION: {question}

EXPECTED ANSWER (if provided): {expected_answer if expected_answer else 'Not provided - use your subject expertise'}

STUDENT'S ANSWER: {answer}

EVALUATION CRITERIA:
1. Correctness - Is the answer factually accurate?
2. Completeness - Does it address all parts of the question?
3. Clarity - Is the response clear and well-structured?
4. Depth - Is there appropriate detail and explanation?

Provide your response in this format:
SCORE: [X out of 10]
FEEDBACK: [Detailed constructive feedback]
STRENGTHS: [What was good about this answer]
IMPROVEMENTS: [What could be better]
CORRECT_ANSWER: [Brief correct answer if needed]"""
        
        url = f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}'
        response = requests.post(
            url,
            json={
                'contents': [{
                    'parts': [{'text': grade_prompt}]
                }],
                'generationConfig': {
                    'temperature': 0.5,
                    'maxOutputTokens': 1500,
                }
            },
            timeout=30
        )
        
        if response.status_code != 200:
            return jsonify({'error': 'Failed to grade answer'}), 500
        
        result = response.json()
        grading = result['candidates'][0]['content']['parts'][0]['text']
        
        # Parse score from grading
        score = "N/A"
        if "SCORE:" in grading:
            score_text = grading.split("SCORE:")[1].split("\n")[0].strip()
            score = score_text
        
        grade_id = f"grade_{datetime.now().timestamp()}"
        session['graded_answers'].append({
            'id': grade_id,
            'student_name': student_name,
            'question': question,
            'answer': answer,
            'grading': grading,
            'score': score,
            'created_at': datetime.now().isoformat()
        })
        session['stats']['answers_graded'] += 1
        
        return jsonify({
            'grade_id': grade_id,
            'grading': grading,
            'score': score,
            'success': True
        })
        
    except Exception as e:
        print(f"[DEBUG] Error grading answer: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/teacher/session/<session_id>', methods=['GET'])
def get_teacher_session(session_id):
    """Get teacher session details"""
    if session_id not in teacher_sessions:
        return jsonify({'error': 'Session not found'}), 404
    
    session = teacher_sessions[session_id]
    # Don't return full content to save bandwidth
    return jsonify({
        'id': session['id'],
        'created_at': session['created_at'],
        'has_syllabus': len(session['syllabus']) > 0,
        'has_pyq': len(session['pyq']) > 0,
        'stats': session['stats']
    })

@app.route('/api/teacher/download-paper/<paper_id>', methods=['GET'])
def download_question_paper(paper_id):
    """Download generated question paper as PDF"""
    try:
        # Find the paper
        for session_id, session in teacher_sessions.items():
            for paper in session['generated_papers']:
                if paper['id'] == paper_id:
                    if not HAS_REPORTLAB:
                        return jsonify({'error': 'PDF generation not available'}), 500
                    
                    # Create PDF
                    buffer = io.BytesIO()
                    doc = SimpleDocTemplate(buffer, pagesize=letter)
                    styles = getSampleStyleSheet()
                    story = []
                    
                    # Add title
                    title_style = ParagraphStyle(
                        'CustomTitle',
                        parent=styles['Heading1'],
                        fontSize=24,
                        textColor='#000000',
                        spaceAfter=30,
                        alignment=1
                    )
                    story.append(Paragraph("QUESTION PAPER", title_style))
                    story.append(Spacer(1, 0.2*inch))
                    
                    # Add content
                    story.append(Paragraph(paper['content'].replace("\n", "<br/>"), styles['Normal']))
                    
                    # Build PDF
                    doc.build(story)
                    buffer.seek(0)
                    
                    return buffer.getvalue(), 200, {
                        'Content-Type': 'application/pdf',
                        'Content-Disposition': f'attachment; filename="question_paper_{paper_id}.pdf"'
                    }
        
        return jsonify({'error': 'Paper not found'}), 404
        
    except Exception as e:
        print(f"[DEBUG] Error downloading paper: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/analyze-tone', methods=['POST'])
def analyze_tone():
    """Analyze tone and emotion of user's speech using Gemini"""
    try:
        data = request.json
        transcript = data.get('transcript', '')
        api_key = data.get('api_key')
        
        if not transcript or not api_key:
            return jsonify({'error': 'Missing required fields'}), 400
        
        # Use Gemini to analyze tone based on transcript
        tone_prompt = f"""Analyze the following speech transcript and provide detailed tone/emotion analysis. 
The user spoke this sentence: "{transcript}"

Based on the content and typical speech patterns, analyze and provide:
1. Confidence Level (very low/low/medium/high/very high)
2. Speech Rate (slow/normal/fast) - infer from typical speech patterns
3. Emotion (confident/nervous/excited/thoughtful/uncertain/neutral)
4. Nervousness Indicators (none/mild/moderate/high) - look for hesitations, repetitions, or uncertainty phrases
5. Clarity (poor/fair/good/excellent) - based on how well-structured the response is

Respond in JSON format:
{{
    "confidence": "level",
    "speech_rate": "rate",
    "emotion": "emotion",
    "nervousness_level": "level",
    "clarity": "level",
    "feedback": "brief feedback about their delivery"
}}"""
        
        url = f'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}'
        response = requests.post(
            url,
            json={
                'contents': [{
                    'parts': [{'text': tone_prompt}]
                }],
                'generationConfig': {
                    'temperature': 0.3,
                    'maxOutputTokens': 1000,
                }
            },
            timeout=10
        )
        
        if response.status_code != 200:
            print(f"[DEBUG] Tone analysis failed: {response.text}")
            return jsonify({
                'tone_analysis': {
                    'confidence': 'medium',
                    'speech_rate': 'normal',
                    'emotion': 'neutral',
                    'nervousness_level': 'mild',
                    'clarity': 'good',
                    'feedback': 'Unable to analyze tone details'
                }
            })
        
        result = response.json()
        ai_response = result['candidates'][0]['content']['parts'][0]['text']
        
        # Parse the JSON response
        try:
            # Extract JSON from the response
            json_start = ai_response.find('{')
            json_end = ai_response.rfind('}') + 1
            if json_start >= 0 and json_end > json_start:
                json_str = ai_response[json_start:json_end]
                tone_data = json.loads(json_str)
            else:
                tone_data = {
                    'confidence': 'medium',
                    'speech_rate': 'normal',
                    'emotion': 'neutral',
                    'nervousness_level': 'mild',
                    'clarity': 'good',
                    'feedback': ai_response
                }
        except json.JSONDecodeError:
            tone_data = {
                'confidence': 'medium',
                'speech_rate': 'normal',
                'emotion': 'neutral',
                'nervousness_level': 'mild',
                'clarity': 'good',
                'feedback': ai_response
            }
        
        print(f"[DEBUG] Tone analysis result: {tone_data}")
        
        return jsonify({
            'tone_analysis': tone_data,
            'success': True
        })
        
    except Exception as e:
        print(f"[DEBUG] Exception in analyze_tone: {str(e)}")
        return jsonify({
            'error': str(e),
            'tone_analysis': {
                'confidence': 'medium',
                'speech_rate': 'normal',
                'emotion': 'neutral',
                'nervousness_level': 'mild',
                'clarity': 'good'
            }
        }), 500

# ============ INTERACTIVE LEARNING ENDPOINTS ============

@app.route('/api/learning/create-session', methods=['POST'])
def create_learning_session():
    """Create interactive learning session"""
    try:
        data = request.json
        topic = data.get('topic', '')
        content = data.get('content', '')
        user_id = data.get('user_id', '')
        
        session_id = generate_uuid()
        created_at = datetime.now().isoformat()
        
        conn = get_db()
        cursor = conn.cursor()
        
        cursor.execute('''
        INSERT INTO learning_sessions (id, student_id, topic, content, audio_recordings, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ''', (session_id, user_id, topic, content, json.dumps([]), created_at))
        
        conn.commit()
        conn.close()
        
        return jsonify({
            'session_id': session_id,
            'success': True
        }), 201
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/learning/save-audio', methods=['POST'])
def save_audio_recording():
    """Save audio recording from interactive learning with mic"""
    try:
        data = request.json
        session_id = data.get('session_id')
        audio_blob = data.get('audio_blob', '')  # Base64 encoded
        transcript = data.get('transcript', '')
        
        conn = get_db()
        cursor = conn.cursor()
        
        # Get session
        cursor.execute('SELECT audio_recordings FROM learning_sessions WHERE id = ?', (session_id,))
        session = cursor.fetchone()
        
        if not session:
            conn.close()
            return jsonify({'error': 'Session not found'}), 404
        
        recordings = json.loads(session['audio_recordings'])
        recordings.append({
            'timestamp': datetime.now().isoformat(),
            'audio_size': len(audio_blob),  # Store size for reference
            'transcript': transcript
        })
        
        cursor.execute('UPDATE learning_sessions SET audio_recordings = ? WHERE id = ?',
                      (json.dumps(recordings), session_id))
        
        conn.commit()
        conn.close()
        
        return jsonify({
            'success': True,
            'message': 'Audio recording saved'
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/learning/get-session/<session_id>', methods=['GET'])
def get_learning_session(session_id):
    """Get learning session details"""
    try:
        conn = get_db()
        cursor = conn.cursor()
        
        cursor.execute('''
        SELECT id, topic, content, audio_recordings, created_at FROM learning_sessions WHERE id = ?
        ''', (session_id,))
        
        session = cursor.fetchone()
        conn.close()
        
        if not session:
            return jsonify({'error': 'Session not found'}), 404
        
        session = dict(session)
        session['audio_recordings'] = json.loads(session['audio_recordings'])
        
        return jsonify({
            'success': True,
            'session': session
        }), 200
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    print("🚀 AI Interview Coach Backend Server")
    print("=" * 50)
    print("Server starting on http://localhost:5000")
    print("=" * 50)
    app.run(debug=True, host='0.0.0.0', port=5000)
