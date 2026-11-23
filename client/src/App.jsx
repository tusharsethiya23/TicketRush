import { Link, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import RequireAuth from './components/RequireAuth.jsx';
import { LoginPage, RegisterPage } from './pages/AuthPages.jsx';
import BookingsPage from './pages/BookingsPage.jsx';
import CheckoutPage from './pages/CheckoutPage.jsx';
import EventPage from './pages/EventPage.jsx';
import EventsPage from './pages/EventsPage.jsx';
import AdminPage from './pages/admin/AdminPage.jsx';
import EventFormPage from './pages/organiser/EventFormPage.jsx';
import OrganiserEventsPage from './pages/organiser/OrganiserEventsPage.jsx';
import SalesPage from './pages/organiser/SalesPage.jsx';

const guard = (roles, page) => <RequireAuth roles={roles}>{page}</RequireAuth>;

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<EventsPage />} />
        <Route path="events/:id" element={<EventPage />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="register" element={<RegisterPage />} />
        <Route path="checkout/:holdId" element={guard(['user'], <CheckoutPage />)} />
        <Route path="bookings" element={guard(['user'], <BookingsPage />)} />
        <Route path="organiser/events" element={guard(['organiser'], <OrganiserEventsPage />)} />
        <Route path="organiser/events/new" element={guard(['organiser'], <EventFormPage />)} />
        <Route path="organiser/events/:id/edit" element={guard(['organiser'], <EventFormPage />)} />
        <Route path="organiser/events/:id/sales" element={guard(['organiser'], <SalesPage />)} />
        <Route path="admin" element={guard(['admin'], <AdminPage />)} />
        <Route
          path="*"
          element={
            <div className="empty">
              <h1>Page not found</h1>
              <Link to="/" className="btn btn-primary">
                Browse events
              </Link>
            </div>
          }
        />
      </Route>
    </Routes>
  );
}
